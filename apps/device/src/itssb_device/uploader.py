"""Authenticated telemetry upload to `POST /device/v1/telemetry` (docs/04 §9, docs/08 §4-5).

Reads committed outbox rows and sends bounded batches (event count AND body
bytes). The payload sent is exactly the stored one, so a retry after a lost
response reuses the same eventIds and the backend answers `duplicate`.

Outcome handling:

| Response                       | Rows                                 | Uploader                 |
|--------------------------------|--------------------------------------|--------------------------|
| 200 + results                  | per-event `apply_results`            | backend ok               |
| 200 malformed, 5xx, no answer  | all sent stay pending, backoff       | backoff                  |
| 401 / 403                      | untouched (queue kept)               | long pause, visible      |
| 413                            | untouched                            | halve the batch size     |
| 429                            | untouched                            | pause for Retry-After    |
| other 4xx                      | untouched                            | pause, visible fault     |

Network and backend are reported separately: failing to connect at all is a
network problem; connecting but getting an error or no answer is a backend
problem. A small TCP probe keeps `network` honest while the queue is empty.
"""

from __future__ import annotations

import errno
import http.client
import json
import logging
import socket
import ssl
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from . import __version__
from .config import Config
from .database import Database
from .status import StatusBoard, wall_ms
from .sync import (
    MAX_BACKOFF_MS,
    apply_results,
    backoff_ms,
    no_jitter,
    note_request_failure,
    with_jitter,
)

log = logging.getLogger(__name__)

TELEMETRY_PATH = "/device/v1/telemetry"
HEALTH_PATH = "/device/v1/health"
# Heartbeat period (packages/contracts HEALTH_INTERVAL_MS). Health lets
# families tell "connected, no GPS fix" from "no contact" (docs/08 §7).
HEALTH_INTERVAL_S = 30.0
AUTH_PAUSE_MS = 5 * 60_000
CLIENT_ERROR_PAUSE_MS = 60_000
PROBE_INTERVAL_S = 30.0
# While paused because the bus had no internet, probe more often so fresh
# tracking resumes within seconds of the link coming back (docs/13 D08).
OFFLINE_PROBE_INTERVAL_S = 5.0


_NO_ROUTE_ERRNOS = {errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ENETDOWN}


def classify(exc: BaseException, connected: bool) -> tuple[str, str]:
    """Maps a transport failure to separate (network, backend) states.

    Only "we could not reach the host at all" means the network is offline.
    A refused/reset connection or a TLS failure means something answered,
    so the network is up and the backend is the problem.
    """
    if isinstance(exc, ssl.SSLError):
        return "online", "tls_error"
    if connected:
        return "online", "no_response"
    if isinstance(exc, socket.gaierror):
        return "offline", "unreachable"  # DNS failed
    if isinstance(exc, TimeoutError):
        return "offline", "unreachable"  # connect timed out
    if isinstance(exc, OSError) and exc.errno in _NO_ROUTE_ERRNOS:
        return "offline", "unreachable"
    if isinstance(exc, ConnectionRefusedError | ConnectionResetError):
        return "online", "unreachable"  # the host answered; nothing is serving
    return "unknown", "unreachable"


class TransportError(Exception):
    def __init__(self, exc: BaseException, connected: bool) -> None:
        self.reason = type(exc).__name__
        super().__init__(self.reason)
        self.network, self.backend = classify(exc, connected)


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    headers: dict[str, str]
    body: bytes


class HttpTransport:
    """One reused connection with explicit timeouts and verified TLS."""

    def __init__(self, origin: str, timeout_s: float) -> None:
        parts = urlsplit(origin)
        self.scheme = parts.scheme
        self.host = parts.hostname or ""
        self.port = parts.port or (443 if self.scheme == "https" else 80)
        self.timeout_s = timeout_s
        self._ssl = ssl.create_default_context() if self.scheme == "https" else None
        self._conn: http.client.HTTPConnection | None = None

    def _connect(self) -> http.client.HTTPConnection:
        if self._conn is None:
            if self._ssl is not None:
                conn: http.client.HTTPConnection = http.client.HTTPSConnection(
                    self.host, self.port, timeout=self.timeout_s, context=self._ssl
                )
            else:
                conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout_s)
            try:
                conn.connect()
            except (OSError, http.client.HTTPException) as exc:
                conn.close()
                raise TransportError(exc, connected=False) from exc
            self._conn = conn
        return self._conn

    def post(self, path: str, body: bytes, headers: dict[str, str]) -> HttpResponse:
        reused = self._conn is not None
        conn = self._connect()
        try:
            conn.request("POST", path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
        except (OSError, http.client.HTTPException) as exc:
            self.close()
            if reused and isinstance(exc, http.client.RemoteDisconnected | BrokenPipeError):
                # A kept-alive connection the server had already closed; one
                # fresh attempt is safe because the payload is idempotent.
                return self.post(path, body, headers)
            raise TransportError(exc, connected=True) from exc
        if resp.getheader("Connection", "").lower() == "close":
            self.close()
        return HttpResponse(resp.status, {k.lower(): v for k, v in resp.getheaders()}, data)

    def probe(self) -> tuple[str, str | None]:
        """TCP reachability of the backend host: (network status, reason)."""
        try:
            with socket.create_connection((self.host, self.port), timeout=self.timeout_s):
                return "online", None
        except OSError as exc:
            return classify(exc, connected=False)[0], type(exc).__name__

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None


def _retry_after_ms(resp: HttpResponse) -> int | None:
    raw = resp.headers.get("retry-after")
    if raw and raw.strip().isdigit():
        return int(raw.strip()) * 1000
    try:
        err = json.loads(resp.body).get("error", {})
        value = err.get("retryAfterMs")
        return int(value) if isinstance(value, int | float) and value >= 0 else None
    except (ValueError, AttributeError):
        return None


def _error_code(resp: HttpResponse) -> str | None:
    try:
        code = json.loads(resp.body).get("error", {}).get("code")
        return code if isinstance(code, str) else None
    except (ValueError, AttributeError):
        return None


class Uploader:
    def __init__(
        self,
        db: Database,
        board: StatusBoard,
        transport: HttpTransport,
        token: str,
        max_events: int = 50,
        max_bytes: int = 128 * 1024,
        now_ms: Callable[[], int] = wall_ms,
        jitter: Callable[[int], int] = no_jitter,
    ) -> None:
        self.db, self.board, self.transport = db, board, transport
        self._token = token
        self.max_events, self.max_bytes = max_events, max_bytes
        self.batch_limit = max_events
        self._now_ms = now_ms
        self._jitter = jitter
        self.pause_until_ms = 0
        # Why we are paused. Only an "offline" pause (we could not reach the
        # host at all) may be ended early by a probe that reaches it again;
        # a pause the server asked for (401/403, 413, 429, 5xx) is kept.
        self.pause_reason: str | None = None
        self.failures = 0  # consecutive request-level failures

    def _batch(self, now: int) -> tuple[list[str], bytes] | None:
        payloads = self.db.pending_payloads(now, limit=self.batch_limit, newest_first=True)
        if not payloads:
            return None
        events: list[dict[str, Any]] = []
        body = b""
        for p in payloads:
            candidate = json.dumps(
                {"schemaVersion": 1, "events": [*events, p]}, separators=(",", ":")
            ).encode()
            if len(candidate) > self.max_bytes and events:
                break
            events.append(p)
            body = candidate
        return [e["eventId"] for e in events], body

    def _pause(self, ms: int, reason: str = "server") -> None:
        self.pause_until_ms = self._now_ms() + ms
        self.pause_reason = reason

    @property
    def paused_offline(self) -> bool:
        return self.pause_reason == "offline" and self._now_ms() < self.pause_until_ms

    def _fail(self, sent: list[str], now: int, reason: str = "server") -> None:
        """Outcome unknown or server-side failure: retry the same identities."""
        note_request_failure(self.db, sent, "REQUEST_FAILED")
        self.failures += 1
        self._pause(self._jitter(backoff_ms(self.failures)), reason)

    def upload_once(self) -> str:
        """Sends at most one batch. Returns a short outcome label."""
        now = self._now_ms()
        if now < self.pause_until_ms:
            return "paused"
        batch = self._batch(now)
        if batch is None:
            return "idle"
        sent, body = batch
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
        }
        try:
            resp = self.transport.post(TELEMETRY_PATH, body, headers)
        except TransportError as exc:
            self.board.network(exc.network, None if exc.network == "online" else exc.reason)
            self.board.backend(exc.backend, exc.reason)
            log.warning(
                "upload of %d events failed (%s); will retry same eventIds", len(sent), exc.reason
            )
            self._fail(sent, now, "offline" if exc.network == "offline" else "server")
            return "transport_error"

        self.board.network("online")
        code = _error_code(resp)
        if resp.status == 200:
            try:
                results = json.loads(resp.body)["results"]
                if not isinstance(results, list):
                    raise TypeError
                results = [r for r in results if isinstance(r, dict)]
            except (ValueError, KeyError, TypeError):
                self.board.backend("bad_response", "unparseable 200 body", 200)
                self._fail(sent, now)
                return "bad_response"
            summary = apply_results(self.db, sent, results, now, jitter=self._jitter)
            self.failures = 0
            self.pause_reason = None
            self.batch_limit = min(self.max_events, self.batch_limit * 2)
            self.board.backend("ok", None, 200, lastBatch={"sent": len(sent), **summary})
            log.info("upload: %d sent %s", len(sent), summary)
            return "ok"
        if resp.status in (401, 403):
            status = "credential_rejected" if resp.status == 401 else "forbidden"
            self.board.backend(status, code, resp.status)
            log.error("upload: backend says %s (%s); queue kept, pausing", status, code)
            self._pause(AUTH_PAUSE_MS)
            return status
        if resp.status == 413:
            self.batch_limit = max(1, len(sent) // 2)
            self.board.backend("ok_split", code, 413)
            if len(sent) == 1:
                self._pause(CLIENT_ERROR_PAUSE_MS)
            return "split"
        if resp.status == 429:
            wait = _retry_after_ms(resp) or self._jitter(backoff_ms(self.failures + 1))
            self.board.backend("rate_limited", code, 429, retryAfterMs=wait)
            self._pause(min(wait, MAX_BACKOFF_MS))
            return "rate_limited"
        if 400 <= resp.status < 500:
            self.board.backend("request_rejected", code, resp.status)
            log.error("upload: request rejected HTTP %s (%s); pausing", resp.status, code)
            self._pause(CLIENT_ERROR_PAUSE_MS)
            return "request_rejected"
        self.board.backend("error", code, resp.status)
        log.warning("upload: HTTP %s; will retry same eventIds", resp.status)
        self._fail(sent, now)
        return "server_error"

    def health_report(self) -> dict[str, Any]:
        """docs/08 §7 body from what this process measured. No coordinates."""
        snap = self.board.snapshot()
        counts = self.db.outbox_counts()
        run = self.db.active_run()
        return {
            "schemaVersion": 1,
            "bootId": snap["process"]["bootId"],
            "capturedAtMs": self._now_ms(),
            "appVersion": __version__[:32],
            "runId": run["runId"] if run else None,
            "gpsStatus": snap["gps"]["status"],
            "lastValidFixAtMs": snap["gps"]["lastValidFixCapturedAtMs"],
            "pendingCount": counts["pending"],
            "oldestPendingCapturedAtMs": counts["oldestPendingCapturedAtMs"],
        }

    def send_health(self) -> str:
        """One heartbeat. Independent of the outbox: failing never touches
        queued rows or the upload pause, and reaching the backend counts as
        proof the internet is back."""
        body = json.dumps(self.health_report(), separators=(",", ":")).encode()
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
        }
        try:
            resp = self.transport.post(HEALTH_PATH, body, headers)
        except TransportError as exc:
            self.board.network(exc.network, None if exc.network == "online" else exc.reason)
            return "transport_error"
        self._network_back()
        if resp.status == 200:
            return "ok"
        log.warning("health: HTTP %s (%s)", resp.status, _error_code(resp))
        return "rejected"

    def _network_back(self) -> None:
        self.board.network("online")
        if self.paused_offline:
            log.info("network back; resuming uploads")
            self.pause_until_ms, self.pause_reason, self.failures = 0, None, 0

    def probe_network(self) -> None:
        status, reason = self.transport.probe()
        self.board.network(status, reason)
        if status == "online":
            # The internet is back: resume now instead of waiting out a backoff
            # that grew during the outage. The next batch leads with the
            # newest observation; history drains behind it.
            self._network_back()


class UploaderThread(threading.Thread):
    def __init__(self, config: Config, board: StatusBoard, stop: threading.Event) -> None:
        super().__init__(name="uploader", daemon=True)
        self.config, self.board, self.stop_event = config, board, stop

    def run(self) -> None:
        cfg = self.config
        if not (cfg.device_api_origin and cfg.device_token):
            return  # uploads disabled; health already says "unconfigured"
        db = Database(cfg.database_path)  # opened in this thread (sqlite3 thread affinity)
        transport = HttpTransport(cfg.device_api_origin, cfg.http_timeout_s)
        uploader = Uploader(
            db,
            self.board,
            transport,
            cfg.device_token,
            cfg.max_batch_events,
            cfg.max_batch_bytes,
            jitter=with_jitter,
        )
        last_probe = float("-inf")
        last_health = float("-inf")
        try:
            while not self.stop_event.is_set():
                try:
                    if time.monotonic() - last_health >= HEALTH_INTERVAL_S:
                        last_health = time.monotonic()
                        uploader.send_health()
                    outcome = uploader.upload_once()
                    probe_every = (
                        OFFLINE_PROBE_INTERVAL_S if uploader.paused_offline else PROBE_INTERVAL_S
                    )
                    if (
                        outcome in ("idle", "paused")
                        and time.monotonic() - last_probe >= probe_every
                    ):
                        uploader.probe_network()
                        last_probe = time.monotonic()
                    elif outcome not in ("idle", "paused"):
                        last_probe = time.monotonic()  # a real exchange is a better probe
                    busy = outcome == "ok" and db.pending_payloads(wall_ms(), limit=1)
                except Exception:
                    log.exception("uploader step failed")
                    busy = False
                # Drain a backlog promptly but still in bounded steps.
                self.stop_event.wait(0.2 if busy else cfg.upload_interval_s)
        finally:
            transport.close()
            db.close()
