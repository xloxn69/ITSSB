"""Applies per-event upload results to the outbox (docs/08 §4).

An HTTP 200 does not acknowledge every event. Each event changes state only
according to its own result; events with no result stay pending.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Iterable, Mapping
from typing import Any

from .database import Database

BASE_BACKOFF_MS = 2_000
MAX_BACKOFF_MS = 5 * 60_000


def backoff_ms(attempts: int) -> int:
    """Exponential backoff, capped. `attempts` counts failures so far (>= 1)."""
    return min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** max(0, attempts - 1))


def no_jitter(delay_ms: int) -> int:
    return delay_ms


def with_jitter(delay_ms: int) -> int:
    """Adds up to 20% so many devices don't retry in lockstep."""
    return delay_ms + int(delay_ms * 0.2 * random.random())  # noqa: S311 - not security


def apply_results(
    db: Database,
    sent_event_ids: Iterable[str],
    results: Iterable[Mapping[str, Any]],
    now_ms: int,
    jitter: Callable[[int], int] = no_jitter,
) -> dict[str, int]:
    """Applies results in one transaction. Returns a per-status count of what
    happened to the sent events (`missing` = no result returned)."""
    summary = {"accepted": 0, "duplicate": 0, "rejected": 0, "retryable": 0, "missing": 0}
    sent = list(dict.fromkeys(sent_event_ids))
    by_id = {r.get("eventId"): r for r in results if r.get("eventId") in sent}

    with db.transaction() as tx:
        for event_id in sent:
            result = by_id.get(event_id)
            status = result.get("status") if result else None
            key = status if status in summary else "missing"
            summary[key] += 1

            if status in ("accepted", "duplicate"):
                tx.execute(
                    "UPDATE outbox SET status='acknowledged', last_error=NULL "
                    "WHERE event_id=? AND status='pending'",
                    (event_id,),
                )
            elif status == "rejected":
                # Kept as a dead-letter record with its reason; never retried
                # automatically with the same payload.
                tx.execute(
                    "UPDATE outbox SET status='rejected', last_error=? "
                    "WHERE event_id=? AND status='pending'",
                    (str(result.get("code", "REJECTED")), event_id),
                )
            else:
                # retryable, missing, or unknown: keep pending and back off.
                row = tx.execute(
                    "SELECT attempts FROM outbox WHERE event_id=?", (event_id,)
                ).fetchone()
                attempts = (row["attempts"] if row else 0) + 1
                delay = jitter(backoff_ms(attempts))
                if result and isinstance(result.get("retryAfterMs"), int):
                    delay = max(delay, result["retryAfterMs"])
                tx.execute(
                    "UPDATE outbox SET attempts=?, next_attempt_at_ms=?, last_error=? "
                    "WHERE event_id=? AND status='pending'",
                    (attempts, now_ms + delay, str(status or "NO_RESULT"), event_id),
                )
    return summary
