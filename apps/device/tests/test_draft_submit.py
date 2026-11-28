"""Submitting a finished route draft for staff review (docs/08 §7.1, docs/05
D10-D11), against the local fake backend over real HTTP. FICTIONAL drivers,
grants, places and coordinates only. No wall-clock sleeps: the device clock
is a number the test moves, and sending runs through `tick()`."""

import json
import threading
import uuid

import pytest

from itssb_device.database import Database
from itssb_device.devtools.fake_backend import FakeBackend
from itssb_device.draft_submit import STATUS_REFRESH_MS, DraftDesk, DraftSyncThread
from itssb_device.drafts import Drafts
from itssb_device.driver_api import DriverApi
from itssb_device.local_auth import Driver, RouteChoice, SessionManager, allowed_origins, hash_pin
from itssb_device.models import Fix
from itssb_device.motion import MotionJudge, ObservedFixHolder
from itssb_device.status import StatusBoard
from itssb_device.students import DeviceGrantClient
from itssb_device.uploader import HttpTransport

PIN = "482916"  # fictional
GRANT = "fictional_grant_" + "x" * 24
ROUTE = "demo_route_version_003"
T0 = 1_795_608_000_000
TOKEN = "fake-dev-token"  # noqa: S105 - the fake backend's fictional token


@pytest.fixture(scope="module")
def pin_hash():
    return hash_pin(PIN)


@pytest.fixture
def backend():
    b = FakeBackend(0, token=TOKEN).start()
    b.grants[GRANT] = {ROUTE}
    yield b
    b.stop()


def rid():
    return str(uuid.uuid4())


def client_for(backend):
    return DeviceGrantClient(HttpTransport(backend.origin, 3.0), TOKEN)


class Env:
    """One device with the draft desk and a sync thread's tick. `restart()`
    builds fresh objects on the same SQLite file, as a service restart would."""

    def __init__(self, tmp_path, pin_hash, backend, with_server=True):
        self.backend = backend
        self.now = T0
        self.mono = 1000.0
        self.elapsed_ms = 0
        self.seq = 0
        self.db_path = tmp_path / "d.sqlite3"
        self.pin_hash = pin_hash
        self.with_server = with_server
        Database(self.db_path).close()
        self._build()

    def _build(self):
        self.latest = ObservedFixHolder()
        self.judge = MotionJudge(self.latest, monotonic=lambda: self.mono)
        self.latest.judge = self.judge
        driver = Driver(
            "drv_demo", "Demo Driver", self.pin_hash, GRANT, (RouteChoice(ROUTE, "Demo North"),)
        )
        no_grant = Driver("drv_new", "New Driver", self.pin_hash)
        self.desk = (
            DraftDesk(
                client_for(self.backend), now_ms=lambda: self.now, mono_ms=lambda: self.elapsed_ms
            )
            if self.with_server
            else None
        )
        self.api = DriverApi(
            StatusBoard("3cd44c56-c96b-4b83-a970-5414990bc25a", upload_enabled=True),
            SessionManager({"drv_demo": driver, "drv_new": no_grant}),
            self.judge,
            self.latest,
            self.db_path,
            None,
            allowed_origins(8765),
            now_ms=lambda: self.now,
            monotonic=lambda: self.mono,
            draft_desk=self.desk,
        )
        self.sync = DraftSyncThread(
            self.db_path, client_for(self.backend), threading.Event(), now_ms=lambda: self.now
        )
        r = self.api.handle("GET", "/api/session", {}, b"")
        self.cookie = dict(r.headers)["Set-Cookie"].split(";", 1)[0]
        self.csrf = json.loads(r.body)["csrfToken"]
        self.unlock()

    def unlock(self, driver_id="drv_demo"):
        self.gps()
        assert self.post("/api/session/unlock", {"driverId": driver_id, "pin": PIN})[0] == 200
        assert self.post("/api/motion/parked")[0] == 200

    def restart(self):
        self._build()

    def gps(self, speed=0.0):
        self.seq += 1
        fix = Fix(T0 + self.seq * 1000, 34.1 + self.seq * 3e-4, -83.98, speed, 0.0, 6.0, 3)
        self.latest.set(fix, self.mono)
        return fix

    def advance(self, ms):
        self.now += ms
        self.elapsed_ms += ms
        self.gps()

    def post(self, path, data=None):
        headers = {
            "Cookie": self.cookie,
            "Origin": "http://127.0.0.1:8765",
            "Content-Type": "application/json",
            "X-ITSSB-CSRF": self.csrf,
        }
        r = self.api.handle("POST", path, headers, json.dumps(data or {}).encode())
        return r.status, json.loads(r.body)

    def get(self, path):
        r = self.api.handle("GET", path, {"Cookie": self.cookie}, b"")
        return r.status, json.loads(r.body)

    def draft(self, did):
        code, body = self.get(f"/api/recordings/{did}")
        assert code == 200, body
        return body

    def record(self, stops=("Example Oak Corner", "Example School Gate"), points=4):
        """A finished draft with real sampled points and marked stops."""
        code, d = self.post(
            "/api/recordings",
            {"requestId": rid(), "name": "Maple Loop Morning", "direction": "to_school"},
        )
        assert code == 200, d
        did = d["draftId"]
        db = Database(self.db_path)
        try:
            drafts = Drafts(db)
            for _ in range(points):
                drafts.add_point(did, self.gps(speed=8.0))
        finally:
            db.close()
        self.gps()
        assert self.post("/api/motion/parked")[0] == 200  # stopped again to mark stops
        for name in stops:
            assert (
                self.post(f"/api/recordings/{did}/stops", {"requestId": rid(), "name": name})[0]
                == 200
            )
        assert self.post(f"/api/recordings/{did}/finish")[0] == 200
        return did

    def submit(self, did, request_id=None):
        return self.post(f"/api/recordings/{did}/submit", {"requestId": request_id or rid()})

    def tick(self):
        db = Database(self.db_path)
        try:
            return self.sync.tick(db)
        finally:
            db.close()


def test_submit_is_pending_until_the_server_accepts_it(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    did = env.record()
    code, body = env.submit(did)
    assert code == 200, body
    assert body["submission"] == "pending"
    # Nothing was sent by the request itself, and nothing claims "submitted".
    assert backend.route_drafts == {}
    assert env.draft(did)["submission"] == "pending"
    assert "fictional_grant" not in json.dumps(env.draft(did))  # the grant stays off the screen

    assert env.tick() == 1
    d = env.draft(did)
    assert d["submission"] == "submitted"
    assert d["submissionDetail"]["reviewCheckedAtMs"] == env.now
    [stored] = backend.route_drafts.values()
    assert stored["status"] == "submitted"  # awaiting staff, never auto-approved
    body = stored["body"]
    assert body["deviceDraftId"] == did
    assert [s["label"] for s in body["stops"]] == ["Example Oak Corner", "Example School Gate"]
    assert len(body["path"]) == d["pointCount"] and len(body["path"]) >= 2
    assert body["driverOperatingGrant"] == GRANT


def test_outage_keeps_it_pending_and_retries_the_same_bytes_after_restart(
    tmp_path, pin_hash, backend
):
    env = Env(tmp_path, pin_hash, backend)
    did = env.record()
    env.submit(did)
    backend.mode = "down"
    env.tick()
    env.advance(60_000)
    env.tick()
    d = env.draft(did)
    assert d["submission"] == "pending" and d["submissionDetail"]["attempts"] == 2

    env.restart()  # service restart: the queue is in SQLite
    backend.mode = "ok"
    env.advance(10 * 60_000)
    assert env.tick() == 1
    assert env.draft(did)["submission"] == "submitted"
    assert len(set(backend.draft_bodies)) == 1 and len(backend.draft_bodies) == 3
    assert len(backend.route_drafts) == 1


def test_lost_answer_is_resent_and_the_server_keeps_one_draft(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    did = env.record()
    env.submit(did)
    backend.mode = "drop_response"
    env.tick()
    assert env.draft(did)["submission"] == "pending"  # stored there, but we never heard
    backend.mode = "ok"
    env.advance(10 * 60_000)
    env.tick()
    assert env.draft(did)["submission"] == "submitted"
    assert len(backend.route_drafts) == 1


def test_a_401_keeps_it_pending_and_says_why(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    did = env.record()
    env.submit(did)
    backend.mode = "unauthorized"
    env.tick()
    d = env.draft(did)
    assert d["submission"] == "pending"
    assert "credential" in d["submissionDetail"]["waitingReason"]


def test_a_refusal_is_shown_and_submit_again_reaches_the_same_server_draft(
    tmp_path, pin_hash, backend
):
    env = Env(tmp_path, pin_hash, backend)
    did = env.record()
    env.submit(did)
    # The first send arrives, but its answer is lost; the grant is then withdrawn.
    backend.mode = "drop_response"
    env.tick()
    backend.mode = "ok"
    del backend.grants[GRANT]
    env.advance(10 * 60_000)
    env.tick()
    d = env.draft(did)
    assert d["submission"] == "refused"
    assert "authorization" in d["submissionDetail"]["problem"]
    # Edits stay locked: the server may already hold this content.
    stop_id = env.get(f"/api/recordings/{did}")[1]["stops"][0]["stopId"]
    code, body = env.post(f"/api/recordings/{did}/stops/{stop_id}", {"name": "Example Elm"})
    assert (code, body["error"]) == (409, "SUBMITTED")

    backend.grants[GRANT] = {ROUTE}  # a fresh grant
    code, body = env.submit(did)
    assert code == 200 and body["submission"] == "pending"
    env.tick()
    assert env.draft(did)["submission"] == "submitted"
    assert len(backend.route_drafts) == 1


def test_submitted_drafts_cannot_be_edited(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    did = env.record()
    stops = env.draft(did)["stops"]
    env.submit(did)
    for change in ({"name": "Example Elm"}, {"position": 2}, {"remove": True}):
        code, body = env.post(f"/api/recordings/{did}/stops/{stops[0]['stopId']}", change)
        assert (code, body["error"]) == (409, "SUBMITTED")
    assert [s["name"] for s in env.draft(did)["stops"]] == [s["name"] for s in stops]


def test_double_tap_queues_once_and_a_second_submit_is_refused(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    did = env.record()
    tap = rid()
    assert env.submit(did, tap)[0] == 200
    assert env.submit(did, tap)[0] == 200  # same requestId: same submission
    code, body = env.submit(did)
    assert (code, body["error"]) == (409, "ALREADY_SUBMITTED")
    other = env.record()
    code, body = env.submit(other, tap)
    assert (code, body["error"]) == (409, "REQUEST_ID_CONFLICT")
    db = Database(env.db_path)
    try:
        n = db.conn.execute("SELECT COUNT(*) FROM route_draft_submissions").fetchone()[0]
    finally:
        db.close()
    assert n == 1


def test_submit_needs_unlock_grant_parked_and_a_complete_draft(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    did = env.record()
    no_stops = env.record(stops=())
    assert env.submit(no_stops)[1]["error"] == "NO_STOPS"
    few = env.record(points=0)
    assert env.submit(few)[1]["error"] == "TOO_FEW_POINTS"

    env.gps(speed=8.0)  # driving: parked is gone
    assert env.submit(did)[1]["error"] == "NOT_PARKED"
    env.unlock()
    env.post("/api/session/lock")
    assert env.submit(did)[1]["error"] == "LOCKED"
    env.unlock("drv_new")
    assert env.submit(did)[1]["error"] == "NO_GRANT"
    caps = env.get("/api/status")[1]["capabilities"]
    assert caps["submitRoute"]["available"] is False
    assert env.draft(did)["submission"] == "not_submitted"
    assert env.tick() == 0


def test_a_draft_over_the_point_limit_is_refused_here_not_queued(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    did = env.record()
    db = Database(env.db_path)
    try:
        with db.transaction() as tx:
            tx.executemany(
                "INSERT INTO route_draft_points(draft_id, seq, captured_at_ms, latitude, "
                "longitude, gap_before) VALUES(?, ?, ?, 34.2, -83.9, 0)",
                [(did, 100 + i, T0 + 100_000 + i) for i in range(2001)],
            )
    finally:
        db.close()
    code, body = env.submit(did)
    assert (code, body["error"]) == (409, "TOO_MANY_POINTS")
    assert env.draft(did)["submission"] == "not_submitted"


def test_review_status_shows_approval_and_rejection_with_reason_and_age(
    tmp_path, pin_hash, backend
):
    env = Env(tmp_path, pin_hash, backend)
    a, b = env.record(), env.record()
    env.submit(a)
    env.submit(b)
    env.tick()
    ids = {d["body"]["deviceDraftId"]: k for k, d in backend.route_drafts.items()}
    sent_at = env.now
    backend.decide_draft(ids[a], "approved")
    backend.decide_draft(ids[b], "rejected", "Stop 2 is on the wrong side of the road.")

    env.advance(STATUS_REFRESH_MS)
    code, body = env.post("/api/recordings/review-status")
    assert code == 200 and body["checked"] is True
    by_id = {d["draftId"]: d for d in body["drafts"]}
    assert by_id[a]["submission"] == "approved"
    assert by_id[b]["submission"] == "rejected"
    assert (
        by_id[b]["submissionDetail"]["decisionReason"] == "Stop 2 is on the wrong side of the road."
    )
    assert by_id[a]["submissionDetail"]["reviewCheckedAtMs"] == sent_at + STATUS_REFRESH_MS


def test_review_status_reads_are_rate_limited_and_honest_when_offline(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend)
    did = env.record()
    env.submit(did)
    env.tick()
    checked = env.draft(did)["submissionDetail"]["reviewCheckedAtMs"]
    env.advance(STATUS_REFRESH_MS)
    backend.mode = "down"
    code, body = env.post("/api/recordings/review-status")
    assert code == 200 and body["checked"] is False and body["problem"]
    d = env.draft(did)
    # Still "submitted" with the time it was last actually read.
    assert d["submission"] == "submitted"
    assert d["submissionDetail"]["reviewCheckedAtMs"] == checked
    backend.mode = "ok"
    code, body = env.post("/api/recordings/review-status")  # too soon: not asked again
    assert body["checked"] is False and body["problem"] is None


def test_without_a_server_submit_is_unavailable(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, backend, with_server=False)
    did = env.record()
    code, body = env.submit(did)
    assert (code, body["error"]) == (409, "NO_SERVER")
    caps = env.get("/api/status")[1]["capabilities"]
    assert caps["submitRoute"]["available"] is False
    assert env.draft(did)["submission"] == "not_submitted"
