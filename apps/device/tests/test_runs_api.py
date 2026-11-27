"""Run start and end from the touchscreen, against the local fake backend
(real HTTP, FICTIONAL grants and route versions)."""

import json
import uuid

import pytest

from itssb_device.database import Database, RunNotActive
from itssb_device.devtools.fake_backend import FakeBackend
from itssb_device.driver_api import DriverApi
from itssb_device.local_auth import Driver, RouteChoice, SessionManager, allowed_origins, hash_pin
from itssb_device.models import Fix
from itssb_device.motion import MotionJudge, ObservedFixHolder
from itssb_device.status import StatusBoard
from itssb_device.trips import EndRetryThread, HttpTripEvents
from itssb_device.uploader import HttpTransport

PIN = "482916"
GRANT = "fictional_grant_" + "x" * 24
ROUTE = "demo_route_version_003"
T0 = 1_795_608_000_000


@pytest.fixture(scope="module")
def pin_hash():
    return hash_pin(PIN)


@pytest.fixture
def backend():
    b = FakeBackend(0, token="fake-dev-token").start()  # noqa: S106
    b.grants[GRANT] = {ROUTE}
    yield b
    b.stop()


def events_for(backend):
    return HttpTripEvents(HttpTransport(backend.origin, 3.0), "fake-dev-token")


class Env:
    def __init__(self, tmp_path, pin_hash, events, grant=GRANT, tz="America/New_York"):
        self.latest = ObservedFixHolder()
        self.judge = MotionJudge(self.latest)
        self.latest.judge = self.judge
        self.db_path = tmp_path / "d.sqlite3"
        Database(self.db_path).close()
        driver = Driver(
            "drv_demo", "Demo Driver", pin_hash, grant, (RouteChoice(ROUTE, "Demo Route North"),)
        )
        self.api = DriverApi(
            StatusBoard("3cd44c56-c96b-4b83-a970-5414990bc25a", upload_enabled=True),
            SessionManager({"drv_demo": driver}),
            self.judge,
            self.latest,
            self.db_path,
            None,
            allowed_origins(8765),
            trip_events=events,
            service_timezone=tz,
        )
        r = self.api.handle("GET", "/api/session", {}, b"")
        self.cookie = dict(r.headers)["Set-Cookie"].split(";", 1)[0]
        self.csrf = json.loads(r.body)["csrfToken"]
        self.park()
        self.post("/api/session/unlock", {"driverId": "drv_demo", "pin": PIN})
        self.post("/api/motion/parked")

    def park(self):
        import time

        self.latest.set(Fix(T0, 34.1, -83.98, 0.0, 0.0, 6.0, 3), time.monotonic())

    def post(self, path, data=None):
        headers = {
            "Cookie": self.cookie,
            "Origin": "http://127.0.0.1:8765",
            "Content-Type": "application/json",
            "X-ITSSB-CSRF": self.csrf,
        }
        r = self.api.handle("POST", path, headers, json.dumps(data or {}).encode())
        return r.status, json.loads(r.body)

    def status(self):
        r = self.api.handle("GET", "/api/status", {"Cookie": self.cookie}, b"")
        return json.loads(r.body)

    def db(self):
        return Database(self.db_path)


def rid():
    return str(uuid.uuid4())


def test_start_creates_the_server_issued_run_only(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, events_for(backend))
    assert env.status()["capabilities"]["startRoute"] == {"available": True}
    code, body = env.post("/api/runs/start", {"requestId": rid(), "routeVersionId": ROUTE})
    assert (code, body["status"]) == (200, "accepted")
    db = env.db()
    assert db.active_run()["runId"] == body["runId"] == "demo_run_001"
    db.close()
    sent = json.loads(next(iter(backend.trip_requests.values()))[0])
    assert sent["driverOperatingGrant"] == GRANT and sent["serviceTimezone"] == "America/New_York"
    # A second start while one is active is refused locally.
    code, body = env.post("/api/runs/start", {"requestId": rid(), "routeVersionId": ROUTE})
    assert (code, body["error"]) == (409, "RUN_ACTIVE")


def test_lost_response_then_retry_reuses_the_request_and_makes_one_run(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, events_for(backend))
    backend.mode = "drop_response"  # server starts the run, the answer is lost
    code, body = env.post("/api/runs/start", {"requestId": rid(), "routeVersionId": ROUTE})
    assert (code, body["status"]) == (202, "unknown")
    db = env.db()
    assert db.active_run() is None  # never invented locally
    db.close()
    assert env.status()["runStart"]["pending"] is True
    backend.mode = "ok"
    # The UI's new tap carries a new requestId; the device resends the pending one.
    code, body = env.post("/api/runs/start", {"requestId": rid(), "routeVersionId": ROUTE})
    assert (code, body["status"]) == (200, "accepted")
    assert len(backend.runs) == 1
    assert env.status()["runStart"]["pending"] is False


def test_rejected_grant_records_nothing(tmp_path, pin_hash, backend):
    backend.grants.clear()
    env = Env(tmp_path, pin_hash, events_for(backend))
    code, body = env.post("/api/runs/start", {"requestId": rid(), "routeVersionId": ROUTE})
    assert (code, body["error"]) == (409, "GRANT_NOT_AUTHORIZED")
    assert "transport office" in body["message"]
    db = env.db()
    assert db.active_run() is None and db.pending_start() is None
    db.close()


@pytest.mark.parametrize(
    ("events", "grant", "tz", "words"),
    [
        (None, GRANT, "America/New_York", "no school server"),
        ("x", None, "America/New_York", "not authorized you"),
        ("x", GRANT, None, "time zone"),
    ],
)
def test_start_unavailable_says_why(tmp_path, pin_hash, events, grant, tz, words):
    env = Env(tmp_path, pin_hash, events and object(), grant=grant, tz=tz)
    cap = env.status()["capabilities"]["startRoute"]
    assert cap["available"] is False and words in cap["reason"]
    code, body = env.post("/api/runs/start", {"requestId": rid(), "routeVersionId": ROUTE})
    assert (code, body["error"]) == (409, "START_UNAVAILABLE")


def test_start_refuses_routes_outside_the_drivers_list(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, events_for(backend))
    code, body = env.post("/api/runs/start", {"requestId": rid(), "routeVersionId": "other_route"})
    assert (code, body["error"]) == (400, "BAD_ROUTE")


def test_start_and_end_need_parked(tmp_path, pin_hash, backend):
    import time

    env = Env(tmp_path, pin_hash, events_for(backend))
    env.latest.set(Fix(T0 + 1000, 34.1, -83.98, 6.0, 0.0, 6.0, 3), time.monotonic())
    code, body = env.post("/api/runs/start", {"requestId": rid(), "routeVersionId": ROUTE})
    assert (code, body["error"]) == (409, "NOT_PARKED")
    assert backend.trip_requests == {}


def test_end_completes_locally_first_and_syncs(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, events_for(backend))
    _, started = env.post("/api/runs/start", {"requestId": rid(), "routeVersionId": ROUTE})
    run_id = started["runId"]
    db = env.db()
    db.record_observation(run_id, Fix(T0 + 5000, 34.1, -83.98, 0.0, 0.0, 6.0, 3), "boot", 0)
    db.close()
    code, body = env.post(f"/api/runs/{run_id}/end", {"requestId": rid()})
    assert code == 200 and body["completedLocally"] is True and body["endSync"] == "accepted"
    assert body["summary"]["positionsRecorded"] == 1
    assert backend.runs[run_id]["state"] == "completed"
    end_sent = [json.loads(c) for c, _ in backend.trip_requests.values() if '"endRun"' in c]
    assert end_sent[0]["lastRunSequence"] == 0
    db = env.db()
    with pytest.raises(RunNotActive):  # nothing records after the end
        db.record_observation(run_id, Fix(T0 + 9000, 34.1, -83.98, 0.0, 0.0, 6.0, 3), "boot", 1)
    db.close()
    assert env.status()["lastEndedRun"]["endSync"] == "accepted"


def test_end_while_server_down_stays_pending_then_retries_same_request(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, events_for(backend))
    _, started = env.post("/api/runs/start", {"requestId": rid(), "routeVersionId": ROUTE})
    run_id = started["runId"]
    backend.mode = "down"
    code, body = env.post(f"/api/runs/{run_id}/end", {"requestId": rid()})
    assert (code, body["endSync"]) == (200, "pending")
    db = env.db()
    assert db.active_run() is None  # completed locally even without the server
    # A double tap resends the SAME saved end command; it never builds a second one.
    first = db.pending_end_payloads()[0]["requestId"]
    code, again = env.post(f"/api/runs/{run_id}/end", {"requestId": rid()})
    assert (code, again["endSync"]) == (200, "pending")
    assert [p["requestId"] for p in db.pending_end_payloads()] == [first]
    backend.mode = "ok"
    retry = EndRetryThread(env.db_path, events_for(backend), stop=None, now_ms=lambda: T0)
    assert retry.tick(db) == 1
    assert db.pending_end_payloads() == []
    assert backend.runs[run_id]["state"] == "completed"
    db.close()


def test_end_payload_matches_the_shared_fixture_shape(tmp_path):
    db = Database(tmp_path / "d.sqlite3")
    db.save_run("demo_run_001", "active")
    payload = db.end_run_locally("demo_run_001", rid(), GRANT, T0)
    assert set(payload) == {
        "schemaVersion",
        "requestId",
        "type",
        "driverOperatingGrant",
        "runId",
        "capturedAtMs",
        "lastRunSequence",
    }
    assert payload["lastRunSequence"] is None  # nothing recorded
    db.close()
