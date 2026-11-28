"""Learning that the school cancelled the active run (docs/13 D14, docs/08 §4, §7).

Staff can cancel a run, or send a replacement bus, from the console. The Pi
hears it two ways, and both end the run locally as `cancelled`:

- a health answer whose `run` names the run the report was for, with
  `state: "cancelled"`. This is the path that matters: a Pi with no GPS fix
  records nothing, so it uploads no telemetry, but it still sends health
  every 30 seconds;
- a telemetry result rejected with `RUN_CANCELLED` for one of its rows.

Nothing is sent back (no endRun: the run is already over on the server), no
driver unlock or GPS fix is needed, and no queued row changes here: each one
keeps whatever result the server gives it. Anything malformed is ignored.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable, Mapping
from typing import Any

from .database import Database

log = logging.getLogger(__name__)


def _ms(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _cancel(
    db: Database, run_id: str, cancelled_at_ms: int | None, now_ms: int, source: str
) -> bool:
    if db.cancel_run_locally(run_id, cancelled_at_ms, now_ms, source):
        log.warning("run %s was cancelled by the school (%s); recording stopped", run_id, source)
        return True
    return False


def note_health_answer(db: Database, reported_run_id: str | None, body: bytes, now_ms: int) -> bool:
    """Acts on a 200 health answer for a report that named `reported_run_id`."""
    if reported_run_id is None:
        return False
    try:
        run = json.loads(body).get("run")
    except (ValueError, AttributeError):
        return False
    if (
        not isinstance(run, dict)
        or run.get("runId") != reported_run_id
        or run.get("state") != "cancelled"
    ):
        return False
    return _cancel(db, reported_run_id, _ms(run.get("cancelledAtMs")), now_ms, "health")


def note_telemetry_results(
    db: Database, results: Iterable[Mapping[str, Any]], now_ms: int
) -> list[str]:
    """Acts on per-event results; returns the runs this call ended."""
    ended: list[str] = []
    for r in results:
        if r.get("status") != "rejected" or r.get("code") != "RUN_CANCELLED":
            continue
        event_id = r.get("eventId")
        run_id = db.run_of_event(event_id) if isinstance(event_id, str) else None
        if run_id and _cancel(db, run_id, _ms(r.get("cancelledAtMs")), now_ms, "telemetry"):
            ended.append(run_id)
    return ended
