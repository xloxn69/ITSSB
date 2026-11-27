"""Local API request and session protection (docs/04 §11-12, docs/05 §8, docs/17 §3).

Loopback binding limits who can connect, not which web page is asking. A page
from anywhere that the kiosk browser visits could aim requests at
127.0.0.1:8765, so every protected request must prove it came from the
driver UI this service served:

1. Host names a loopback host (blocks DNS rebinding). Checked in api.py.
2. State changes carry an Origin that is exactly this service's origin
   (scheme, host, AND port: SameSite cookies do not isolate ports), never
   `null`; `Sec-Fetch-Site`, when sent, is `same-origin`; and the body is JSON.
3. A kiosk session cookie (HttpOnly, SameSite=Strict) issued with the UI page.
4. A per-session CSRF token in the `X-ITSSB-CSRF` header. Only same-origin
   script can read it (`GET /api/session` sends no CORS headers).
5. Sensitive actions also need an unlocked driver (PIN) on that session.

PINs are verified against scrypt hashes provisioned by an administrator in a
root-owned drivers file. There is no plaintext PIN, no default PIN, and no
override PIN. Failures are rate limited for the whole device.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

SESSION_COOKIE = "itssb_kiosk"
CSRF_HEADER = "X-ITSSB-CSRF"
MAX_KIOSK_SESSIONS = 8
DRIVER_SESSION_MAX_S = 12 * 3600  # one long shift; Lock ends it sooner

# scrypt parameters: ~16 MiB and well under a second on a Pi 5.
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1

FREE_ATTEMPTS = 5
LOCKOUT_BASE_S = 30.0
LOCKOUT_MAX_S = 15 * 60.0


# ── Request checks ───────────────────────────────────────────────────


def allowed_origins(port: int) -> frozenset[str]:
    return frozenset({f"http://127.0.0.1:{port}", f"http://localhost:{port}"})


def check_state_change(headers: Mapping[str, str], origins: frozenset[str]) -> str | None:
    """Returns why a state-changing request is refused, or None if it may proceed
    to the session and CSRF checks."""
    origin = headers.get("Origin")
    if origin is None or origin == "null" or origin not in origins:
        return "origin not allowed"
    site = headers.get("Sec-Fetch-Site")
    if site is not None and site != "same-origin":
        return "cross-site request"
    ctype = (headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
    if ctype != "application/json":
        return "JSON body required"
    return None


def check_protected_read(headers: Mapping[str, str]) -> str | None:
    """Protected reads come from same-origin script. A browser that sends
    Sec-Fetch-Site says where the request came from; refuse anything else."""
    site = headers.get("Sec-Fetch-Site")
    if site is not None and site not in ("same-origin", "none"):
        return "cross-site request"
    return None


def read_cookie(header: str | None, name: str = SESSION_COOKIE) -> str | None:
    if not header:
        return None
    for part in header.split(";"):
        k, _, v = part.strip().partition("=")
        if k == name and v:
            return v
    return None


# ── PIN hashing ──────────────────────────────────────────────────────


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def hash_pin(pin: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.scrypt(pin.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(dk)}"


def verify_pin(pin: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt, expected = encoded.split("$")
        if scheme != "scrypt":
            return False
        dk = hashlib.scrypt(
            pin.encode(),
            salt=base64.b64decode(salt),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(base64.b64decode(expected)),
            maxmem=64 * 1024 * 1024,
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, base64.b64decode(expected))


def valid_pin_format(pin: object) -> bool:
    return isinstance(pin, str) and pin.isdigit() and 4 <= len(pin) <= 12


# ── Drivers provisioned on this device ───────────────────────────────


@dataclass(frozen=True, slots=True)
class Driver:
    driver_id: str
    display_name: str
    pin_hash: str


def load_drivers(path: Path | None) -> dict[str, Driver]:
    """Reads the administrator-provisioned drivers file. A missing or invalid
    file means no driver can unlock; it never falls back to a default."""
    if path is None or not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text())
        drivers = {}
        for d in raw["drivers"]:
            driver = Driver(str(d["driverId"]), str(d["displayName"]), str(d["pinHash"]))
            if not driver.pin_hash.startswith("scrypt$"):
                raise ValueError(f"driver {driver.driver_id}: pinHash must be an scrypt hash")
            drivers[driver.driver_id] = driver
        return drivers
    except (OSError, ValueError, KeyError, TypeError) as exc:
        log.error("drivers file %s unusable (%s); no driver can unlock", path, exc)
        return {}


# ── Kiosk sessions ───────────────────────────────────────────────────


@dataclass(slots=True)
class KioskSession:
    session_id: str
    csrf: str
    driver: Driver | None = None
    unlocked_mono: float | None = None


class UnlockResult:
    OK = "ok"
    WRONG = "wrong_pin"
    LOCKED_OUT = "locked_out"
    UNKNOWN_DRIVER = "unknown_driver"
    BAD_INPUT = "bad_input"


class SessionManager:
    def __init__(
        self,
        drivers: dict[str, Driver],
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.drivers = drivers
        self._mono = monotonic
        self._lock = threading.Lock()
        self._sessions: OrderedDict[str, KioskSession] = OrderedDict()
        self._failures = 0
        self._locked_until: float | None = None

    def new_session(self) -> KioskSession:
        s = KioskSession(secrets.token_urlsafe(32), secrets.token_urlsafe(32))
        with self._lock:
            self._sessions[s.session_id] = s
            while len(self._sessions) > MAX_KIOSK_SESSIONS:
                self._sessions.popitem(last=False)
        return s

    def get(self, session_id: str | None) -> KioskSession | None:
        if not session_id:
            return None
        with self._lock:
            s = self._sessions.get(session_id)
            if s is None:
                return None
            if (
                s.unlocked_mono is not None
                and self._mono() - s.unlocked_mono > DRIVER_SESSION_MAX_S
            ):
                s.driver, s.unlocked_mono = None, None
            return s

    @staticmethod
    def csrf_ok(session: KioskSession, token: str | None) -> bool:
        return token is not None and hmac.compare_digest(session.csrf, token)

    def lockout_remaining_s(self) -> float:
        with self._lock:
            if self._locked_until is None:
                return 0.0
            return max(0.0, self._locked_until - self._mono())

    def unlock(self, session: KioskSession, driver_id: object, pin: object) -> str:
        if not isinstance(driver_id, str) or not valid_pin_format(pin):
            return UnlockResult.BAD_INPUT
        if self.lockout_remaining_s() > 0:
            return UnlockResult.LOCKED_OUT
        driver = self.drivers.get(driver_id)
        # Hash even for an unknown driver so timing does not reveal the roster.
        ok = verify_pin(pin, driver.pin_hash) if driver else (verify_pin(pin, _DUMMY) and False)
        with self._lock:
            if ok and driver:
                self._failures = 0
                self._locked_until = None
                session.driver, session.unlocked_mono = driver, self._mono()
                log.info("driver %s unlocked", driver.driver_id)
                return UnlockResult.OK
            self._failures += 1
            if self._failures >= FREE_ATTEMPTS:
                extra = self._failures - FREE_ATTEMPTS
                self._locked_until = self._mono() + min(LOCKOUT_MAX_S, LOCKOUT_BASE_S * 2**extra)
            log.warning("driver unlock failed (%d consecutive)", self._failures)
            return UnlockResult.UNKNOWN_DRIVER if driver is None else UnlockResult.WRONG

    def lock(self, session: KioskSession) -> None:
        with self._lock:
            session.driver, session.unlocked_mono = None, None


_DUMMY = hash_pin("000000", salt=b"itssb-dummy-salt")
