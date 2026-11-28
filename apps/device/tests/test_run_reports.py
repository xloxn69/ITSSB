"""Delay reports (D20) and "stopped near a stop" (D14) on the local API
(docs/08 §9.4, docs/05 D14/D20), against the local fake backend over real
HTTP. FICTIONAL students, stops and grants only. No wall-clock sleeps:
retries run through `tick()`."""

import json
import threading
from pathlib import Path

import pytest
from test_students import GRANT, PIN, ROUTE, STUDENTS, TOKEN, Env, client_for, rid

from itssb_device.database import Database, GuardRefused
from itssb_device.devtools.fake_backend import FakeBackend
from itssb_device.local_auth import hash_pin
from itssb_device.models import Fix
from itssb_device.roster_contracts import Roster
from itssb_device.run_reports import RunReportDesk, RunReportSyncThread

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures"

# Fictional stops for ROUTE; Oak & Pine is where Env parks the bus.
STOPS = [
    {
        "stopId": "demo_stop_001",
        "label": "Oak & Pine",
        "sequence": 0,
        "latitude": 34.1,
        "longitude": -83.98,
    },
    {
        "stopId": "demo_stop_002",
        "label": "Maple Court",
        "sequence": 1,
        "latitude": 34.11,
        "longitude": -83.97,
    },
]


@pytest.fixture(scope="module")
def pin_hash():
    return hash_pin(PIN)


@pytest.fixture
def backend():
    b = FakeBackend(0, token=TOKEN).start()
    b.grants[GRANT] = {ROUTE}
    b.roster_students[ROUTE] = [dict(s) for s in STUDENTS]
    b.roster_stops[ROUTE] = [dict(s) for s in STOPS]
    yield b
    b.stop()


class ReportEnv(Env):
    def _build(self):
        super()._build()
        self.api.run_reports = RunReportDesk(now_ms=lambda: self.now)
        self.report_sync = RunReportSyncThread(
            self.db_path, client_for(self.backend), threading.Event(), now_ms=lambda: self.now
        )

    def report(self, **data):
        data.setdefault("requestId", rid())
        data.setdefault("category", "traffic")
        data.setdefault("minutes", 10)
        return self.post("/api/run-reports", data)

    def send(self):
        db = Database(self.db_path)
        try:
            return self.report_sync.tick(db)
        finally:
            db.close()

    def reports(self):
        return {r["requestId"]: r for r in self.status()["runReports"]}

    def park_at(self, lat, lon):
        self.latest.set(Fix(self.now, lat, lon, 0.0, 0.0, 6.0, 3), self.mono)


@pytest.fixture
def env(tmp_path, pin_hash, backend):
    return ReportEnv(tmp_path, pin_hash, backend)


# ── D20: report a delay ──────────────────────────────────────────────


def test_saved_before_sending_and_sent_only_after_the_server_accepts(env, backend):
    backend.mode = "down"
    code, body = env.report(requestId=(r := rid()))
    assert code == 200, body
    assert body["report"]["sync"] == "pending"
    assert GRANT not in env.last_raw.decode()  # the payload with the grant never reaches the screen
    assert env.send() == 1
    assert env.reports()[r]["sync"] == "pending"  # a 503 is no answer: still waiting
    backend.mode = "ok"
    env.advance(120_000)  # past the backoff
    assert env.send() == 1
    view = env.reports()[r]
    assert view["sync"] == "sent"
    assert backend.run_reports[r][1]["expectedDelayMinutes"] == 10


def test_a_lost_answer_is_resent_with_the_same_bytes_and_stored_once(env, backend):
    backend.mode = "drop_response"
    env.report(requestId=(r := rid()))
    env.send()
    assert env.reports()[r]["sync"] == "pending"
    backend.mode = "ok"
    env.advance(120_000)
    env.send()
    assert env.reports()[r]["sync"] == "sent"
    assert len(backend.report_bodies) == 2
    assert backend.report_bodies[0] == backend.report_bodies[1]
    assert len(backend.run_reports) == 1


def test_a_pending_report_survives_a_restart(env, backend):
    backend.mode = "down"
    env.report(requestId=(r := rid()), category="mechanical", minutes=None)
    env.restart()
    assert env.reports()[r]["sync"] == "pending"
    backend.mode = "ok"
    env.send()
    assert env.reports()[r]["sync"] == "sent"
    assert backend.run_reports[r][1]["category"] == "mechanical"


def test_the_same_request_id_with_other_details_is_refused_locally(env, backend):
    r = rid()
    assert env.report(requestId=r)[0] == 200
    assert env.report(requestId=r)[0] == 200  # a double tap: the same report
    code, body = env.report(requestId=r, minutes=30)
    assert code == 409 and body["error"] == "REQUEST_ID_CONFLICT"
    db = Database(env.db_path)
    try:
        assert db.conn.execute("SELECT COUNT(*) FROM run_reports").fetchone()[0] == 1
    finally:
        db.close()


def test_a_server_refusal_is_final_and_stays_visible(env, backend):
    backend.grants.clear()
    env.report(requestId=(r := rid()))
    env.send()
    view = env.reports()[r]
    assert view["sync"] == "refused"
    assert "authorization" in view["problem"]
    env.advance(120_000)
    assert env.send() == 0  # never resent


@pytest.mark.parametrize(
    "data",
    [
        {"category": "late"},
        {"minutes": 0},
        {"minutes": 121},
        {"minutes": True},
        {"minutes": 2.5},
        {"requestId": "not-a-uuid"},
    ],
)
def test_input_outside_the_fixed_lists_is_refused(env, data):
    code, body = env.report(**data)
    assert code == 400, body


def test_locked_and_moving_are_refused(env):
    env.latest.set(Fix(env.now, 34.1, -83.98, 9.0, 0.0, 6.0, 3), env.mono)  # moving
    assert env.report()[1]["error"] == "NOT_PARKED"
    env.park()
    env.post("/api/motion/parked")
    env.post("/api/session/lock")
    assert env.report()[0] == 403
    assert env.status()["runReports"] is None  # nothing about reports while locked


def test_no_active_run_is_refused(tmp_path, pin_hash, backend):
    idle = ReportEnv(tmp_path, pin_hash, backend, start_run=False)
    assert idle.report()[1]["error"] == "NO_ACTIVE_RUN"


def test_another_routes_driver_can_not_report_on_this_run(env):
    env.post("/api/session/lock")
    env.post("/api/session/unlock", {"driverId": "drv_other", "pin": PIN})
    code, body = env.report()
    assert code == 403 and body["error"] == "NOT_YOUR_ROUTE"


def test_the_bus_moving_while_the_save_waits_saves_nothing(env):
    def moved():
        raise GuardRefused("NOT_PARKED", "moved")

    db = Database(env.db_path)
    try:
        session = env.api.sessions.get(env.cookie.split("=", 1)[1])
        with pytest.raises(GuardRefused):
            env.api.run_reports.report(
                db, session, {"requestId": rid(), "category": "weather", "minutes": 5}, guard=moved
            )
        assert db.conn.execute("SELECT COUNT(*) FROM run_reports").fetchone()[0] == 0
    finally:
        db.close()


def test_report_wire_matches_the_shared_fixture(env, backend):
    fixture = json.loads((FIXTURES / "runReport.request.json").read_text())
    env.report(requestId=fixture["requestId"])
    env.send()
    sent = json.loads(backend.report_bodies[0])
    assert sorted(sent) == sorted(fixture)
    assert sent["category"] == "traffic" and sent["expectedDelayMinutes"] == 10


# ── D14: stopped near a stop ─────────────────────────────────────────


def test_parked_at_a_stop_names_it_and_its_students(env):
    code, body = env.get("/api/stop")
    assert code == 200, body
    assert body["position"] == "fresh"
    assert body["nearStop"]["label"] == "Oak & Pine"
    assert body["nearStop"]["distanceM"] <= body["nearRadiusM"]
    names = [s["studentDisplayName"] for s in body["students"] if s["stopId"] == "demo_stop_001"]
    assert names == ["Blake Example"]


def test_parked_away_from_every_stop_is_not_called_near_one(env):
    env.park_at(34.105, -83.975)  # between the stops, several hundred metres from each
    code, body = env.get("/api/stop")
    assert code == 200
    assert body["nearStop"] is None
    assert body["nearestStop"]["distanceM"] > body["nearRadiusM"]


def test_without_a_fresh_fix_the_position_is_unknown(env, monkeypatch):
    monkeypatch.setattr(env.api, "_fresh_fix", lambda: None)
    code, body = env.get("/api/stop")
    assert code == 200
    assert body["position"] == "unknown" and body["nearStop"] is None


def test_an_older_server_without_stops_is_never_near_a_stop(env, backend):
    backend.roster_stops.clear()
    code, body = env.get("/api/stop")
    assert code == 200
    assert body["stops"] == [] and body["nearStop"] is None


def test_the_stop_screen_needs_an_unlocked_driver_and_a_parked_bus(env):
    env.latest.set(Fix(env.now, 34.1, -83.98, 9.0, 0.0, 6.0, 3), env.mono)
    assert env.get("/api/stop")[1]["error"] == "NOT_PARKED"
    env.park()
    env.post("/api/motion/parked")
    env.post("/api/session/lock")
    assert env.get("/api/stop")[0] == 403


def test_roster_stops_decode_and_default_to_none():
    roster = Roster.from_wire(json.loads((FIXTURES / "roster.response.json").read_text()))
    assert [s.label for s in roster.stops] == ["Oak & Pine", "Maple Court", "Cedar Loop"]
    body = json.loads((FIXTURES / "roster.response.json").read_text())
    del body["stops"]
    assert Roster.from_wire(body).stops == ()
