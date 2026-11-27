"""QR codes, the roster and queued driver actions on the local API (docs/08 §9.2,
docs/09 §6-§9), against the local fake backend over real HTTP. FICTIONAL
students, grants and route versions only. No wall-clock sleeps: the device
clock is a number the test moves, and retries run through `tick()`."""

import json
import threading
import uuid

import pytest

from itssb_device.database import Database
from itssb_device.devtools.fake_backend import FakeBackend
from itssb_device.driver_api import DriverApi
from itssb_device.local_auth import Driver, RouteChoice, SessionManager, allowed_origins, hash_pin
from itssb_device.models import Fix
from itssb_device.motion import MotionJudge, ObservedFixHolder
from itssb_device.status import StatusBoard
from itssb_device.students import (
    QR_REFRESH_BEFORE_MS,
    ROSTER_REUSE_MS,
    DeviceGrantClient,
    RosterSyncThread,
    StudentDesk,
)
from itssb_device.trips import HttpTripEvents
from itssb_device.uploader import HttpTransport

PIN = "482916"  # fictional
GRANT = "fictional_grant_" + "x" * 24
ROUTE = "demo_route_version_003"
OTHER_PIN = "731406"  # fictional
OTHER_GRANT = "fictional_grant_" + "y" * 24
OTHER_ROUTE = "demo_route_version_099"
T0 = 1_795_608_000_000
TOKEN = "fake-dev-token"  # noqa: S105 - the fake backend's fictional token

STUDENTS = [
    {
        "assignmentId": "demo_assignment_001",
        "studentDisplayName": "Sam Example",
        "stopId": "demo_stop_002",
        "stopLabel": "Maple Court",
        "stopSequence": 1,
        "seatLabel": "4A",
        "driverNote": None,
    },
    {
        "assignmentId": "demo_assignment_002",
        "studentDisplayName": "Blake Example",
        "stopId": "demo_stop_001",
        "stopLabel": "Oak & Pine",
        "stopSequence": 0,
        "seatLabel": None,
        "driverNote": None,
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
    yield b
    b.stop()


def client_for(backend):
    return DeviceGrantClient(HttpTransport(backend.origin, 3.0), TOKEN)


def rid():
    return str(uuid.uuid4())


class Env:
    """One device: driver API with the student desk, a sync thread's tick, and
    a clock the test moves. `restart()` builds fresh objects on the same
    SQLite file, as a service restart would."""

    def __init__(self, tmp_path, pin_hash, backend, start_run=True, db_path=None):
        self.backend = backend
        self.now = T0
        self.mono = 1000.0
        self.elapsed_ms = 0  # monotonic time for code lifetimes; never steps back
        self.db_path = db_path or tmp_path / "d.sqlite3"
        self.pin_hash = pin_hash
        Database(self.db_path).close()
        self._build()
        if start_run:
            code, body = self.post("/api/runs/start", {"requestId": rid(), "routeVersionId": ROUTE})
            assert code == 200, body
            self.run_id = body["runId"]

    def _build(self):
        self.latest = ObservedFixHolder()
        self.judge = MotionJudge(self.latest, monotonic=lambda: self.mono)
        self.latest.judge = self.judge
        driver = Driver(
            "drv_demo",
            "Demo Driver",
            self.pin_hash,
            GRANT,
            (RouteChoice(ROUTE, "Demo Route North"),),
        )
        # A second fictional driver authorized for a different route only.
        other = Driver(
            "drv_other",
            "Other Driver",
            self.pin_hash,
            OTHER_GRANT,
            (RouteChoice(OTHER_ROUTE, "Demo Route South"),),
        )
        self.desk = StudentDesk(
            self.db_path,
            client_for(self.backend),
            now_ms=lambda: self.now,
            mono_ms=lambda: self.elapsed_ms,
        )
        self.api = DriverApi(
            StatusBoard("3cd44c56-c96b-4b83-a970-5414990bc25a", upload_enabled=True),
            SessionManager({"drv_demo": driver, "drv_other": other}),
            self.judge,
            self.latest,
            self.db_path,
            None,
            allowed_origins(8765),
            now_ms=lambda: self.now,
            monotonic=lambda: self.mono,
            trip_events=HttpTripEvents(HttpTransport(self.backend.origin, 3.0), TOKEN),
            service_timezone="America/New_York",
            students=self.desk,
        )
        self.sync = RosterSyncThread(
            self.db_path, client_for(self.backend), threading.Event(), now_ms=lambda: self.now
        )
        r = self.api.handle("GET", "/api/session", {}, b"")
        self.cookie = dict(r.headers)["Set-Cookie"].split(";", 1)[0]
        self.csrf = json.loads(r.body)["csrfToken"]
        self.park()
        self.post("/api/session/unlock", {"driverId": "drv_demo", "pin": PIN})
        self.post("/api/motion/parked")

    def restart(self):
        self._build()

    def park(self):
        self.latest.set(Fix(T0, 34.1, -83.98, 0.0, 0.0, 6.0, 3), self.mono)

    def advance(self, ms):
        """Device time moves; the bus stays parked (fresh, still fix)."""
        self.now += ms
        self.elapsed_ms += ms
        self.park()

    def post(self, path, data=None):
        headers = {
            "Cookie": self.cookie,
            "Origin": "http://127.0.0.1:8765",
            "Content-Type": "application/json",
            "X-ITSSB-CSRF": self.csrf,
        }
        r = self.api.handle("POST", path, headers, json.dumps(data or {}).encode())
        self.last_raw = r.body
        return r.status, json.loads(r.body)

    def get(self, path):
        r = self.api.handle("GET", path, {"Cookie": self.cookie}, b"")
        self.last_raw = r.body
        return r.status, json.loads(r.body)

    def status(self):
        return self.get("/api/status")[1]

    def tick(self):
        db = Database(self.db_path)
        try:
            return self.sync.tick(db)
        finally:
            db.close()

    def action(self, **data):
        data.setdefault("requestId", rid())
        return self.post("/api/roster-actions", data)

    def roster(self):
        return self.get("/api/roster")

    def actions(self):
        code, body = self.roster()
        assert code == 200, body
        return {a["requestId"]: a for a in body["actions"]}


# ── Access ───────────────────────────────────────────────────────────


def test_locked_session_cannot_read_roster_or_get_a_code(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.post("/api/session/lock")
    code, body = env.roster()
    assert (code, body["error"]) == (403, "LOCKED")
    code, body = env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert (code, body["error"]) == (403, "LOCKED")
    code, body = env.action(type="recordAttendance", assignmentId="demo_assignment_001")
    assert (code, body["error"]) == (403, "LOCKED")
    assert backend.qr_issued == []
    caps = env.status()["capabilities"]
    assert caps["showQr"]["available"] is True  # unlock is checked by the screen, then here
    assert "students" not in json.dumps(env.status())  # no roster behind the lock


def test_codes_and_roster_need_an_active_run(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend, start_run=False)
    caps = env.status()["capabilities"]
    assert caps["showQr"]["available"] is False and "active run" in caps["showQr"]["reason"]
    assert caps["showStudents"]["available"] is False
    code, body = env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert (code, body["error"]) == (409, "NO_ACTIVE_RUN")
    code, body = env.roster()
    assert (code, body["error"]) == (409, "NO_ACTIVE_RUN")


def test_codes_roster_and_actions_need_parked(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.latest.set(Fix(T0 + 1000, 34.1, -83.98, 6.0, 0.0, 6.0, 3), env.mono)  # moving
    assert env.post("/api/qr-codes", {"purpose": "trip_check_in"})[1]["error"] == "NOT_PARKED"
    assert env.roster()[1]["error"] == "NOT_PARKED"
    code, body = env.action(type="recordAttendance", assignmentId="demo_assignment_001")
    assert (code, body["error"]) == (409, "NOT_PARKED")


def test_the_grant_never_reaches_the_browser(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert GRANT.encode() not in env.last_raw
    env.roster()
    assert GRANT.encode() not in env.last_raw
    env.action(type="recordAttendance", assignmentId="demo_assignment_001", status="boarded")
    assert GRANT.encode() not in env.last_raw
    env.roster()
    assert GRANT.encode() not in env.last_raw


# ── QR codes ─────────────────────────────────────────────────────────


def test_the_two_codes_have_distinct_purposes_and_scopes(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    code, trip = env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert code == 200
    assert trip["purpose"] == "trip_check_in" and trip["label"] == "Check in for this trip"
    assert trip["runId"] == env.run_id and trip["remainingMs"] == 600_000
    code, join = env.post("/api/qr-codes", {"purpose": "route_enrollment"})
    assert code == 200
    assert join["purpose"] == "route_enrollment" and join["label"] == "Join this route"
    assert join["routeVersionId"] == ROUTE
    assert trip["token"] != join["token"] and trip["label"] != join["label"]
    sent = [q["purpose"] for q in backend.qr_issued]
    assert sent == ["trip_check_in", "route_enrollment"]
    code, body = env.post("/api/qr-codes", {"purpose": "guardian_link"})
    assert (code, body["error"]) == (400, "BAD_PURPOSE")


def test_check_in_code_is_reused_then_refreshed_before_it_expires(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    first = env.post("/api/qr-codes", {"purpose": "trip_check_in"})[1]
    env.advance(60_000)
    again = env.post("/api/qr-codes", {"purpose": "trip_check_in"})[1]
    assert again["token"] == first["token"] and again["remainingMs"] == 540_000
    assert len(backend.qr_issued) == 1  # one code serves every student
    env.advance(600_000 - 60_000 - QR_REFRESH_BEFORE_MS + 1)
    fresh = env.post("/api/qr-codes", {"purpose": "trip_check_in"})[1]
    assert fresh["token"] != first["token"] and fresh["remainingMs"] == 600_000


def test_an_expired_code_is_never_shown(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    first = env.post("/api/qr-codes", {"purpose": "trip_check_in"})[1]
    backend.mode = "rate_limited"  # the refresh is certainly not applied
    env.advance(600_000 - QR_REFRESH_BEFORE_MS + 1)  # due a refresh
    code, body = env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert code == 200 and body["token"] == first["token"]
    assert body["refreshFailed"] is True and 0 < body["remainingMs"] < QR_REFRESH_BEFORE_MS
    env.advance(QR_REFRESH_BEFORE_MS)  # now past its expiry
    code, body = env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert (code, body["error"]) == (503, "QR_UNAVAILABLE")
    assert first["token"] not in json.dumps(body)
    assert "Show Students" in body["message"]  # the staff fallback


@pytest.mark.parametrize("mode", ["down", "drop_response"])
def test_a_refresh_that_may_have_revoked_the_code_drops_it(tmp_path, pin_hash, backend, mode):
    # The server may have issued a new code (revoking the shown one) and the
    # answer was lost: the old code must not stay on screen as valid.
    env = Env(tmp_path, pin_hash, backend)
    first = env.post("/api/qr-codes", {"purpose": "trip_check_in"})[1]
    backend.mode = mode
    env.advance(600_000 - QR_REFRESH_BEFORE_MS + 1)
    code, body = env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert (code, body["error"]) == (503, "QR_UNAVAILABLE")
    assert first["token"] not in json.dumps(body)
    backend.mode = "ok"
    code, body = env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert code == 200 and body["token"] != first["token"]


def test_an_enrollment_code_stays_while_the_server_is_unreachable(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    first = env.post("/api/qr-codes", {"purpose": "route_enrollment"})[1]
    backend.mode = "down"  # refreshing an invitation does not revoke the last one
    env.advance(86_400_000 - QR_REFRESH_BEFORE_MS + 1)
    code, body = env.post("/api/qr-codes", {"purpose": "route_enrollment"})
    assert code == 200 and body["token"] == first["token"] and body["refreshFailed"] is True


def test_a_code_stops_when_the_run_ends(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    code, _ = env.post(f"/api/runs/{env.run_id}/end", {"requestId": rid()})
    assert code == 200
    code, body = env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert (code, body["error"]) == (409, "NO_ACTIVE_RUN")
    assert len(backend.qr_issued) == 1


def test_a_refused_code_is_not_shown_from_cache(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    backend.grants.clear()  # the grant was revoked
    env.advance(600_000 - QR_REFRESH_BEFORE_MS + 1)
    code, body = env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert (code, body["error"]) == (403, "GRANT_NOT_AUTHORIZED")
    backend.mode = "down"
    code, body = env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert (code, body["error"]) == (503, "QR_UNAVAILABLE")


# ── Roster ───────────────────────────────────────────────────────────


def test_roster_in_stop_order_then_served_stale_when_offline(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    code, body = env.roster()
    assert code == 200 and body["stale"] is False and body["runId"] == env.run_id
    assert [s["studentDisplayName"] for s in body["students"]] == ["Blake Example", "Sam Example"]
    assert body["fetchedAtMs"] == T0
    backend.mode = "down"
    env.advance(ROSTER_REUSE_MS + 30_000)
    code, body = env.roster()
    assert code == 200 and body["stale"] is True
    assert body["fetchedAtMs"] == T0 and body["ageMs"] == ROSTER_REUSE_MS + 30_000
    assert [s["assignmentId"] for s in body["students"]] == [
        "demo_assignment_002",
        "demo_assignment_001",
    ]


def test_no_roster_at_all_when_offline_with_nothing_cached(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    backend.mode = "down"
    code, body = env.roster()
    assert (code, body["error"]) == (503, "ROSTER_UNAVAILABLE")


def test_a_refused_roster_clears_the_cache(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    assert env.roster()[0] == 200
    backend.grants.clear()
    env.advance(ROSTER_REUSE_MS + 1)
    code, body = env.roster()
    assert (code, body["error"]) == (403, "GRANT_NOT_AUTHORIZED")
    backend.mode = "down"
    env.advance(ROSTER_REUSE_MS + 1)
    code, body = env.roster()
    assert (code, body["error"]) == (503, "ROSTER_UNAVAILABLE")


# ── Driver actions ───────────────────────────────────────────────────


def test_action_is_saved_pending_and_retried_with_the_same_request(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    backend.mode = "down"
    request_id = rid()
    code, body = env.action(
        requestId=request_id,
        type="recordAttendance",
        assignmentId="demo_assignment_002",
        status="boarded",
    )
    assert code == 200 and body["action"]["sync"] == "pending"
    assert body["action"]["capturedAtMs"] == T0
    env.tick()
    assert env.actions()[request_id]["sync"] == "pending"
    backend.mode = "ok"
    env.advance(120_000)
    env.tick()
    a = env.actions()[request_id]
    assert a["sync"] == "synced" and a["result"] == "accepted"
    assert a["checkIn"]["source"] == "staff_recorded"
    bodies = backend.action_bodies[request_id]
    assert len(bodies) == 2 and bodies[0] == bodies[1]  # the same bytes, not rebuilt
    sent = json.loads(bodies[0])
    assert sent["capturedAtMs"] == T0 and sent["runId"] == env.run_id
    assert sent["driverOperatingGrant"] == GRANT
    env.advance(120_000)
    assert env.tick() == 0  # nothing left to send


def test_a_lost_response_is_retried_with_the_same_request(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    backend.mode = "drop_response"  # the server applies it, the answer is lost
    request_id = rid()
    env.action(
        requestId=request_id,
        type="recordAttendance",
        assignmentId="demo_assignment_002",
        status="boarded",
    )
    env.tick()
    assert env.actions()[request_id]["sync"] == "pending"
    backend.mode = "ok"
    env.advance(120_000)
    env.tick()
    assert env.actions()[request_id]["sync"] == "synced"
    assert len(backend.check_ins[(env.run_id, "demo_assignment_002")]) == 1
    bodies = backend.action_bodies[request_id]
    assert len(set(bodies)) == 1


def test_pending_rows_survive_a_restart(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    backend.mode = "down"
    first, second = rid(), rid()
    env.action(
        requestId=first,
        type="recordAttendance",
        assignmentId="demo_assignment_002",
        status="boarded",
    )
    env.action(
        requestId=second,
        type="setSeatNote",
        assignmentId="demo_assignment_001",
        seatLabel="5B",
        driverNote="Uses the front step",
    )
    env.tick()
    env.restart()
    actions = env.actions()  # served from the cached roster while the server is down
    assert actions[first]["sync"] == "pending" and actions[second]["sync"] == "pending"
    backend.mode = "ok"
    env.advance(120_000)
    assert env.tick() == 2
    actions = env.actions()
    assert actions[first]["sync"] == "synced" and actions[second]["sync"] == "synced"
    for request_id in (first, second):
        assert len(set(backend.action_bodies[request_id])) == 1


def test_a_rejected_action_stays_visible_and_is_not_resent(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    backend.reject_actions = "grant_not_authorized"
    request_id = rid()
    env.action(
        requestId=request_id,
        type="recordAttendance",
        assignmentId="demo_assignment_002",
        status="not_boarded",
    )
    env.tick()
    a = env.actions()[request_id]
    assert a["sync"] == "rejected" and a["code"] == "grant_not_authorized"
    assert a["problem"]  # words the driver can read
    env.advance(3_600_000)
    env.tick()
    assert len(backend.action_bodies[request_id]) == 1
    assert env.actions()[request_id]["sync"] == "rejected"


def test_a_removal_is_not_done_until_the_server_accepts_it(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    backend.mode = "down"
    request_id = rid()
    code, body = env.action(
        requestId=request_id,
        type="removeAssignment",
        assignmentId="demo_assignment_001",
        reason="Moved to another school",
    )
    assert code == 200 and body["action"]["sync"] == "pending"
    env.tick()
    code, roster = env.roster()
    names = [s["studentDisplayName"] for s in roster["students"]]
    assert "Sam Example" in names  # still listed: the removal is only queued
    pending = env.actions()[request_id]
    assert pending["type"] == "removeAssignment" and pending["sync"] == "pending"
    assert pending["studentDisplayName"] == "Sam Example"
    # A second removal for the same student is refused while one is pending.
    code, body = env.action(
        type="removeAssignment", assignmentId="demo_assignment_001", reason="Moved away"
    )
    assert (code, body["error"]) == (409, "REMOVAL_PENDING")
    backend.mode = "ok"
    env.advance(120_000)
    env.tick()
    code, roster = env.roster()
    assert "Sam Example" not in [s["studentDisplayName"] for s in roster["students"]]
    done = {a["requestId"]: a for a in roster["actions"]}[request_id]
    assert done["sync"] == "synced" and done["studentDisplayName"] == "Sam Example"


def test_a_rejected_removal_keeps_the_student_and_says_so(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    backend.reject_actions = "assignment_not_authorized"
    request_id = rid()
    env.action(
        requestId=request_id,
        type="removeAssignment",
        assignmentId="demo_assignment_001",
        reason="Moved to another school",
    )
    env.tick()
    env.advance(ROSTER_REUSE_MS + 1)
    _, roster = env.roster()
    assert "Sam Example" in [s["studentDisplayName"] for s in roster["students"]]
    a = {x["requestId"]: x for x in roster["actions"]}[request_id]
    assert a["sync"] == "rejected" and a["code"] == "assignment_not_authorized"


def test_a_correction_names_the_current_record(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    env.action(type="recordAttendance", assignmentId="demo_assignment_002", status="boarded")
    env.tick()
    env.advance(ROSTER_REUSE_MS + 1)
    roster = env.roster()[1]
    current = next(s for s in roster["students"] if s["assignmentId"] == "demo_assignment_002")
    assert current["checkIn"]["source"] == "staff_recorded"
    request_id = rid()
    code, _ = env.action(
        requestId=request_id,
        type="correctAttendance",
        assignmentId="demo_assignment_002",
        status="not_boarded",
        reason="Stayed home today",
    )
    assert code == 200
    env.tick()
    a = env.actions()[request_id]
    assert a["sync"] == "synced" and a["checkIn"]["source"] == "staff_correction"
    sent = json.loads(backend.action_bodies[request_id][0])
    assert sent["correctsCheckInId"] == current["checkIn"]["checkInId"]


def test_a_correction_needs_an_existing_record(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    code, body = env.action(
        type="correctAttendance",
        assignmentId="demo_assignment_002",
        status="boarded",
        reason="Was on board",
    )
    assert (code, body["error"]) == (409, "NOTHING_TO_CORRECT")


def test_same_request_id_returns_the_saved_action_and_new_content_conflicts(
    tmp_path, pin_hash, backend
):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    backend.mode = "down"
    request_id = rid()
    data = {
        "requestId": request_id,
        "type": "recordAttendance",
        "assignmentId": "demo_assignment_002",
        "status": "boarded",
    }
    first = env.post("/api/roster-actions", data)[1]["action"]
    env.advance(5_000)  # a double tap a moment later keeps the first capture time
    again = env.post("/api/roster-actions", data)[1]["action"]
    assert again["capturedAtMs"] == first["capturedAtMs"] == T0
    code, body = env.post("/api/roster-actions", {**data, "status": "not_boarded"})
    assert (code, body["error"]) == (409, "REQUEST_ID_CONFLICT")


@pytest.mark.parametrize(
    ("data", "error"),
    [
        ({"type": "removeAssignment", "assignmentId": "demo_assignment_001"}, "BAD_INPUT"),
        (
            {"type": "removeAssignment", "assignmentId": "demo_assignment_001", "reason": "  "},
            "BAD_INPUT",
        ),
        (
            {
                "type": "removeAssignment",
                "assignmentId": "demo_assignment_001",
                "reason": "x" * 201,
            },
            "BAD_INPUT",
        ),
        (
            {"type": "setSeatNote", "assignmentId": "demo_assignment_001", "seatLabel": "X" * 13},
            "BAD_INPUT",
        ),
        ({"type": "recordAttendance", "assignmentId": "demo_assignment_001"}, "BAD_INPUT"),
        ({"type": "deleteEverything", "assignmentId": "demo_assignment_001"}, "BAD_INPUT"),
        (
            {
                "type": "recordAttendance",
                "assignmentId": "other_route_student",
                "status": "boarded",
            },
            "NOT_ON_ROSTER",
        ),
    ],
)
def test_invalid_actions_are_refused_before_saving(tmp_path, pin_hash, backend, data, error):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    code, body = env.action(**data)
    assert body["error"] == error and code in (400, 409)
    assert env.actions() == {}


def test_blank_seat_and_note_clear_them(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    request_id = rid()
    code, _ = env.action(
        requestId=request_id,
        type="setSeatNote",
        assignmentId="demo_assignment_001",
        seatLabel=" ",
        driverNote="",
    )
    assert code == 200
    env.tick()
    sent = json.loads(backend.action_bodies[request_id][0])
    assert sent["seatLabel"] is None and sent["driverNote"] is None


def test_an_action_whose_grant_ended_before_it_synced_is_rejected_not_pending(
    tmp_path, pin_hash, backend
):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    backend.mode = "down"
    request_id = rid()
    env.action(
        requestId=request_id,
        type="recordAttendance",
        assignmentId="demo_assignment_002",
        status="boarded",
    )
    env.tick()
    backend.grants.clear()  # the grant expired during the outage
    backend.mode = "ok"
    env.advance(120_000)
    env.tick()
    code, body = env.roster()  # the roster is refused too, but queued changes still show
    assert (code, body["error"]) == (403, "GRANT_NOT_AUTHORIZED")
    a = {x["requestId"]: x for x in body["actions"]}[request_id]
    assert a["sync"] == "rejected" and a["code"] == "grant_not_authorized"
    assert "staff" in a["problem"]
    env.advance(3_600_000)
    assert env.tick() == 0


def test_changes_are_sent_in_capture_order(tmp_path, pin_hash, backend):
    # A removal saved after an attendance record that is waiting to be resent
    # must not overtake it, or the attendance would arrive for a removed student.
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    backend.mode = "down"
    first, second = rid(), rid()
    env.action(
        requestId=first,
        type="recordAttendance",
        assignmentId="demo_assignment_001",
        status="boarded",
    )
    env.tick()  # fails; the first change now waits for its retry time
    backend.mode = "ok"
    env.advance(1)
    env.action(
        requestId=second,
        type="removeAssignment",
        assignmentId="demo_assignment_001",
        reason="Moved",
    )
    assert env.tick() == 0  # the removal waits behind the attendance
    env.advance(120_000)
    assert env.tick() == 2
    assert [r for r in backend.action_log if r in (first, second)] == [first, first, second]
    actions = env.actions()
    assert actions[first]["sync"] == "synced" and actions[second]["sync"] == "synced"


def test_a_rejection_after_the_run_ended_is_still_shown(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    backend.mode = "down"
    request_id = rid()
    env.action(
        requestId=request_id,
        type="recordAttendance",
        assignmentId="demo_assignment_002",
        status="boarded",
    )
    env.tick()  # not sent: still pending when the run ends
    backend.mode = "ok"
    assert env.post(f"/api/runs/{env.run_id}/end", {"requestId": rid()})[1]["endSync"] == "accepted"
    backend.reject_actions = "grant_not_authorized"
    env.advance(120_000)
    env.tick()
    changes = env.status()["studentChanges"]  # on the dashboard, with no run
    assert changes["pending"] == 0
    assert [a["requestId"] for a in changes["rejected"]] == [request_id]
    assert "staff" in changes["rejected"][0]["problem"]
    # And on the next run's roster.
    backend.reject_actions = None
    code, body = env.post("/api/runs/start", {"requestId": rid(), "routeVersionId": ROUTE})
    assert code == 200, body
    assert env.actions()[request_id]["sync"] == "rejected"
    env.post("/api/session/lock")
    assert env.status()["studentChanges"] is None  # no names behind the lock


# ── Independent review findings ──────────────────────────────────────


def test_a_driver_for_another_route_never_sees_the_cached_roster(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    assert env.roster()[0] == 200  # driver A caches the run's roster
    backend.mode = "down"  # offline: only the cache could answer
    env.post("/api/session/lock")
    env.post("/api/session/unlock", {"driverId": "drv_other", "pin": PIN})
    env.post("/api/motion/parked")
    code, body = env.roster()
    assert (code, body["error"]) == (403, "NOT_YOUR_ROUTE")
    assert "Example" not in env.last_raw.decode()
    code, body = env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert (code, body["error"]) == (403, "NOT_YOUR_ROUTE")
    code, body = env.action(type="recordAttendance", assignmentId="demo_assignment_002", status="boarded")
    assert (code, body["error"]) == (403, "NOT_YOUR_ROUTE")


def test_a_clock_stepping_back_does_not_extend_a_code(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    first = env.post("/api/qr-codes", {"purpose": "trip_check_in"})[1]
    backend.mode = "rate_limited"  # refresh certainly not applied: cache would be kept
    env.advance(590_000)
    env.now -= 3_600_000  # the wall clock steps back an hour; elapsed time does not
    env.advance(20_000)  # 610 s since issue: past the 600 s lifetime
    code, body = env.post("/api/qr-codes", {"purpose": "trip_check_in"})
    assert code == 503 and first["token"] not in json.dumps(body)


def test_a_record_synced_before_the_roster_refreshed_can_be_corrected(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    env.roster()
    code, _ = env.action(type="recordAttendance", assignmentId="demo_assignment_002", status="boarded")
    assert code == 200
    env.tick()  # accepted; the cached roster still has no record for this student
    backend.mode = "down"  # so the roster can't refresh
    code, body = env.action(
        type="correctAttendance",
        assignmentId="demo_assignment_002",
        status="not_boarded",
        reason="Stayed home",
    )
    assert code == 200, body
    assert body["sync"] == "pending"
