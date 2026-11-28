"""Local driver API rules, called through DriverApi.handle() (no sockets)."""

import json
import uuid

import pytest

from itssb_device.database import Database
from itssb_device.driver_api import DriverApi
from itssb_device.local_auth import Driver, SessionManager, allowed_origins, hash_pin
from itssb_device.models import Fix
from itssb_device.motion import MotionJudge, ObservedFixHolder
from itssb_device.status import StatusBoard

PIN = "482916"  # fictional
T0 = 1_795_608_000_000


class Clock:
    def __init__(self) -> None:
        self.t = 500.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture(scope="module")
def pin_hash():
    return hash_pin(PIN)


class Kiosk:
    """A browser tab on the driver UI: holds the cookie and CSRF token."""

    def __init__(self, api: DriverApi) -> None:
        self.api = api
        r = api.handle("GET", "/", {}, b"")
        assert r.status == 200
        cookie = dict(r.headers)["Set-Cookie"]
        assert "HttpOnly" in cookie and "SameSite=Strict" in cookie
        self.cookie = cookie.split(";", 1)[0]
        info = self.get("/api/session")
        self.csrf = info["csrfToken"]

    def get(self, path, expect=200):
        r = self.api.handle(
            "GET", path, {"Cookie": self.cookie, "Sec-Fetch-Site": "same-origin"}, b""
        )
        assert r.status == expect, r.body
        return json.loads(r.body)

    def headers(self, **over):
        h = {
            "Cookie": self.cookie,
            "Origin": "http://127.0.0.1:8765",
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "same-origin",
            "X-ITSSB-CSRF": self.csrf,
        }
        h.update(over)
        return {k: v for k, v in h.items() if v is not None}

    def post(self, path, data=None, expect=200, **over):
        r = self.api.handle("POST", path, self.headers(**over), json.dumps(data or {}).encode())
        assert r.status == expect, r.body
        return json.loads(r.body)


@pytest.fixture
def env(tmp_path, pin_hash):
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>ITSSB Driver</title>")
    (static / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("outside the UI")
    clock = Clock()
    latest = ObservedFixHolder()
    judge = MotionJudge(latest, monotonic=clock)
    latest.judge = judge
    db_path = tmp_path / "device.sqlite3"
    Database(db_path).close()
    sessions = SessionManager(
        {"drv_demo": Driver("drv_demo", "Demo Driver", pin_hash)}, monotonic=clock
    )
    api = DriverApi(
        StatusBoard("3cd44c56-c96b-4b83-a970-5414990bc25a", upload_enabled=False),
        sessions,
        judge,
        latest,
        db_path,
        static,
        allowed_origins(8765),
        now_ms=lambda: T0,
        monotonic=clock,
    )

    class Env:
        pass

    e = Env()
    e.api, e.clock, e.latest, e.db_path = api, clock, latest, db_path
    seq = [0]

    def gps(speed=0.0):
        seq[0] += 1
        e.latest.set(
            Fix(T0 + seq[0] * 1000, 34.1 + seq[0] * 1e-5, -83.98, speed, 0.0, 6.0, 3), e.clock.t
        )

    e.gps = gps
    return e


def rid():
    return str(uuid.uuid4())


def unlocked_parked(env):
    k = Kiosk(env.api)
    env.gps(0.0)
    k.post("/api/session/unlock", {"driverId": "drv_demo", "pin": PIN})
    k.post("/api/motion/parked")
    return k


# ── Request protection ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "over",
    [
        {"Origin": None},
        {"Origin": "null"},
        {"Origin": "http://127.0.0.1:9999"},
        {"Origin": "http://evil.example"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Content-Type": "text/plain"},
        {"X-ITSSB-CSRF": None},
        {"X-ITSSB-CSRF": "wrong"},
        {"Cookie": None},
        {"Cookie": "itssb_kiosk=forged"},
    ],
)
def test_state_changes_refuse_forged_requests(env, over):
    k = Kiosk(env.api)
    env.gps(0.0)
    r = env.api.handle(
        "POST",
        "/api/session/unlock",
        k.headers(**over),
        json.dumps({"driverId": "drv_demo", "pin": PIN}).encode(),
    )
    assert r.status in (401, 403), r.body
    assert k.get("/api/status")["session"]["unlocked"] is False


def test_another_sessions_csrf_token_does_not_work(env):
    a, b = Kiosk(env.api), Kiosk(env.api)
    env.gps(0.0)
    r = env.api.handle(
        "POST",
        "/api/session/unlock",
        a.headers(**{"X-ITSSB-CSRF": b.csrf}),
        json.dumps({"driverId": "drv_demo", "pin": PIN}).encode(),
    )
    assert r.status == 403


def test_protected_reads_need_the_session_and_same_origin(env):
    k = Kiosk(env.api)
    assert env.api.handle("GET", "/api/status", {}, b"").status == 401
    r = env.api.handle(
        "GET", "/api/status", {"Cookie": k.cookie, "Sec-Fetch-Site": "cross-site"}, b""
    )
    assert r.status == 403
    assert k.get("/api/recordings", expect=403)["error"] == "LOCKED"


def test_status_adds_motion_session_and_capabilities_without_secrets(env):
    k = Kiosk(env.api)
    s = k.get("/api/status")
    assert s["motion"] == {"state": "unknown", "parked": False, "parkedSinceMs": None}
    assert s["session"] == {"unlocked": False, "driverName": None}
    assert s["capabilities"]["recordRoute"]["available"] is True
    assert s["capabilities"]["startRoute"]["available"] is False
    assert s["recording"] is None
    assert "pinHash" not in json.dumps(s) and "csrf" not in json.dumps(s).lower()


def test_session_list_shows_names_never_hashes(env):
    info = Kiosk(env.api).get("/api/session")
    assert info["drivers"] == [{"driverId": "drv_demo", "displayName": "Demo Driver"}]
    assert "scrypt" not in json.dumps(info)


# ── Driver unlock ───────────────────────────────────────────────────


def test_wrong_pin_and_unknown_driver_look_the_same(env):
    k = Kiosk(env.api)
    a = k.post("/api/session/unlock", {"driverId": "drv_demo", "pin": "111111"}, expect=403)
    b = k.post("/api/session/unlock", {"driverId": "drv_nobody", "pin": "111111"}, expect=403)
    assert a == b


def test_lockout_after_repeated_wrong_pins(env):
    k = Kiosk(env.api)
    for _ in range(4):
        k.post("/api/session/unlock", {"driverId": "drv_demo", "pin": "111111"}, expect=403)
    r = k.post("/api/session/unlock", {"driverId": "drv_demo", "pin": "111111"}, expect=429)
    assert r["lockoutRemainingS"] == 30
    k.post("/api/session/unlock", {"driverId": "drv_demo", "pin": PIN}, expect=429)


def test_unlock_refused_while_moving(env):
    k = Kiosk(env.api)
    env.gps(9.0)
    assert (
        k.post("/api/session/unlock", {"driverId": "drv_demo", "pin": PIN}, expect=409)["error"]
        == "MOVING"
    )


def test_reload_keeps_the_session_and_lock_ends_it(env):
    k = unlocked_parked(env)
    r = env.api.handle("GET", "/", {"Cookie": k.cookie}, b"")
    assert "Set-Cookie" not in dict(r.headers)  # same session after reload
    assert k.get("/api/status")["session"]["unlocked"] is True
    k.post("/api/session/lock")
    assert k.get("/api/status")["session"]["unlocked"] is False


# ── Moving-view lockout ─────────────────────────────────────────────


def test_parked_needs_unlock_and_a_stopped_fix(env):
    k = Kiosk(env.api)
    env.gps(0.0)
    assert k.post("/api/motion/parked", expect=403)["error"] == "LOCKED"
    k.post("/api/session/unlock", {"driverId": "drv_demo", "pin": PIN})
    env.gps(7.0)
    assert k.post("/api/motion/parked", expect=409)["error"] == "NOT_STOPPED"
    env.clock.t += 10  # fix goes stale: motion unknown
    assert k.post("/api/motion/parked", expect=409)["error"] == "NOT_STOPPED"


def test_draft_edits_lock_as_soon_as_the_bus_moves(env):
    k = unlocked_parked(env)
    d = k.post(
        "/api/recordings",
        {"requestId": rid(), "name": "Demo Route North", "direction": "to_school"},
    )
    stop = k.post(f"/api/recordings/{d['draftId']}/stops", {"requestId": rid()})
    env.gps(6.0)  # driving
    for path, body in [
        (f"/api/recordings/{d['draftId']}/stops", {"requestId": rid()}),
        (f"/api/recordings/{d['draftId']}/stops/{stop['stopId']}", {"name": "Renamed"}),
        (f"/api/recordings/{d['draftId']}/finish", {}),
    ]:
        assert k.post(path, body, expect=409)["error"] == "NOT_PARKED"
    # Stopping again is not enough: the driver must confirm parked again.
    env.gps(0.0)
    assert k.post(f"/api/recordings/{d['draftId']}/finish", expect=409)["error"] == "NOT_PARKED"
    k.post("/api/motion/parked")
    assert k.post(f"/api/recordings/{d['draftId']}/finish")["status"] == "finished"


# ── Recording ───────────────────────────────────────────────────────


def test_stop_position_comes_from_the_device_not_the_request(env):
    k = unlocked_parked(env)
    d = k.post(
        "/api/recordings",
        {"requestId": rid(), "name": "Demo Route North", "direction": "to_school"},
    )
    stop = k.post(
        f"/api/recordings/{d['draftId']}/stops",
        {"requestId": rid(), "name": "Oak St", "latitude": 1.0, "longitude": 2.0},
    )
    lf = env.latest.get()
    assert (stop["latitude"], stop["longitude"]) == (lf.fix.latitude, lf.fix.longitude)


def test_no_fix_means_no_recording_and_no_stop(env):
    k = unlocked_parked(env)
    env.clock.t += 10
    # Stale fix: un-parked as well, so the parked check answers first.
    r = k.post(
        "/api/recordings", {"requestId": rid(), "name": "X", "direction": "to_school"}, expect=409
    )
    assert r["error"] in ("NOT_PARKED", "NO_FIX")


def test_cannot_record_during_an_active_run(env):
    k = unlocked_parked(env)
    db = Database(env.db_path)
    db.save_run("demo_run_001", "active")
    db.close()
    r = k.post(
        "/api/recordings", {"requestId": rid(), "name": "X", "direction": "to_school"}, expect=409
    )
    assert r["error"] == "RUN_ACTIVE"


def test_full_draft_flow_with_ordered_stops(env):
    k = unlocked_parked(env)
    d = k.post(
        "/api/recordings",
        {"requestId": rid(), "name": "Demo Route North", "direction": "to_school"},
    )
    did = d["draftId"]
    tap = rid()
    a = k.post(f"/api/recordings/{did}/stops", {"requestId": tap, "name": "Oak St"})
    assert (
        k.post(f"/api/recordings/{did}/stops", {"requestId": tap, "name": "Oak St"}) == a
    )  # double tap
    env.gps(0.0)
    b = k.post(f"/api/recordings/{did}/stops", {"requestId": rid(), "name": "Maple Ave"})
    out = k.post(f"/api/recordings/{did}/stops/{b['stopId']}", {"position": 1})
    assert [s["name"] for s in out["stops"]] == ["Maple Ave", "Oak St"]
    k.post(f"/api/recordings/{did}/finish")
    detail = k.get(f"/api/recordings/{did}")
    assert detail["status"] == "finished" and detail["submission"] == "not_submitted"
    assert [s["position"] for s in detail["stops"]] == [1, 2]
    assert k.get("/api/status")["recording"] is None


def test_bad_draft_input_is_a_400(env):
    k = unlocked_parked(env)
    r = k.post(
        "/api/recordings", {"requestId": "nope", "name": "X", "direction": "to_school"}, expect=400
    )
    assert r["error"] == "BAD_REQUEST_ID"
    assert k.post("/api/recordings", data=None, expect=400)["error"] == "BAD_REQUEST_ID"


def test_oversized_and_non_object_bodies(env):
    k = Kiosk(env.api)
    r = env.api.handle("POST", "/api/session/lock", k.headers(), b"x" * 20_000)
    assert r.status == 413
    r = env.api.handle("POST", "/api/session/lock", k.headers(), b"[1]")
    assert r.status == 400


# ── Static files ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path",
    [
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/assets/../../secret.txt",
        "/assets/%2E%2E/%2e%2e/secret.txt",
        "/.hidden",
        "/assets/..%5c..%5csecret.txt",
    ],
)
def test_static_never_leaves_the_ui_directory(env, path):
    r = env.api.handle("GET", path, {}, b"")
    assert r.status == 404
    assert b"outside the UI" not in r.body


def test_static_symlink_out_of_the_ui_is_refused(env, tmp_path):
    (tmp_path / "static" / "link.txt").symlink_to(tmp_path / "secret.txt")
    assert env.api.handle("GET", "/link.txt", {}, b"").status == 404


def test_static_serves_the_ui_with_a_csp(env):
    r = env.api.handle("GET", "/assets/app.js", {}, b"")
    assert r.status == 200 and r.content_type.startswith("text/javascript")
    page = env.api.handle("GET", "/", {}, b"")
    assert "frame-ancestors 'none'" in dict(page.headers)["Content-Security-Policy"]
    assert env.api.handle("POST", "/", {}, b"").status == 405


def test_a_write_queued_behind_another_writer_rechecks_parked(env):
    """Review finding: a stop request that passed the Parked check and then
    waited for the SQLite writer still saved after the bus started moving."""
    import sqlite3
    import threading

    k = unlocked_parked(env)
    d = k.post(
        "/api/recordings",
        {"requestId": rid(), "name": "Demo Route North", "direction": "to_school"},
    )
    blocker = sqlite3.connect(env.db_path, isolation_level=None)
    blocker.execute("BEGIN IMMEDIATE")  # another writer holds the lock
    result = {}

    def mark() -> None:
        r = env.api.handle(
            "POST",
            f"/api/recordings/{d['draftId']}/stops",
            k.headers(),
            json.dumps({"requestId": rid()}).encode(),
        )
        result["status"], result["body"] = r.status, json.loads(r.body)

    t = threading.Thread(target=mark)
    t.start()
    t.join(0.5)  # the request is now waiting on SQLite
    assert t.is_alive()
    env.gps(6.0)  # the bus moves while it waits
    blocker.execute("COMMIT")
    blocker.close()
    t.join(5)
    assert (result["status"], result["body"]["error"]) == (409, "NOT_PARKED")
    db = Database(env.db_path)
    assert db.conn.execute("SELECT COUNT(*) FROM route_draft_stops").fetchone()[0] == 0
    db.close()


# ── D06: the driver page restarts, the service does not ─────────────


def test_d06_page_sessions_opening_reloading_and_closing_never_pause_collection(env):
    from itssb_device.gps_reader import LatestFixHolder
    from itssb_device.recorder import Recorder

    gps = LatestFixHolder()
    rec = Recorder(
        Database(env.db_path),
        env.api.board,
        gps,
        "boot-a",
        monotonic=env.clock,
        now_ms=lambda: T0 + 3_600_000,
    )
    rec.db.save_run("demo_run_001", "active")
    captured = [T0]

    def collect():
        captured[0] += 1000
        gps.set(Fix(captured[0], 34.1, -83.98, 0.0, 0.0, 6.0, 3), env.clock.t)
        assert rec.tick() is True  # collection carries on whatever the page does

    def pending():
        return rec.db.conn.execute(
            "SELECT o.event_id, o.payload, o.status, o.attempts, t.run_sequence FROM outbox o "
            "JOIN telemetry_events t ON t.event_id=o.event_id ORDER BY t.run_sequence"
        ).fetchall()

    collect()
    collect()
    queued = [tuple(r) for r in pending()]

    first = Kiosk(env.api)  # page opens
    collect()
    first.get("/api/status")
    env.api.handle("GET", "/", {"Cookie": first.cookie}, b"")  # reload
    collect()
    env.gps(0.0)
    first.post("/api/session/unlock", {"driverId": "drv_demo", "pin": PIN})
    collect()
    first.post("/api/session/lock")
    collect()
    second = Kiosk(env.api)  # browser restarted: the old page is gone, a new session opens
    collect()
    status = second.get("/api/status")

    rows = pending()
    assert [tuple(r) for r in rows[: len(queued)]] == queued  # earlier rows untouched
    assert [r["run_sequence"] for r in rows] == list(range(7))
    assert {r["status"] for r in rows} == {"pending"}
    assert status["outbox"]["pending"] == 7
    assert status["run"]["runId"] == "demo_run_001"
    assert rec.db.active_run()["nextRunSequence"] == 7
    rec.db.close()
