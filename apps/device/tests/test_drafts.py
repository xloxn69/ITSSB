import itertools
import uuid

import pytest

from itssb_device.database import Database
from itssb_device.drafts import GAP_MS, DraftError, Drafts
from itssb_device.models import Fix

T0 = 1_795_608_000_000


def fix(i: int, at_ms: int | None = None) -> Fix:
    # Fictional coordinates near the docs/08 example, moving north.
    return Fix(
        at_ms if at_ms is not None else T0 + i * 1000, 34.1 + i * 1e-5, -83.98, 5.0, 0.0, 6.0, 3
    )


def rid() -> str:
    return str(uuid.uuid4())


@pytest.fixture
def drafts(tmp_path):
    db = Database(tmp_path / "d.sqlite3")
    yield Drafts(db)
    db.close()


@pytest.fixture
def recording(drafts):
    return drafts.start(rid(), "Demo Route North", "to_school", "drv_demo", T0)["draftId"]


def names(drafts, draft_id):
    return [(s["position"], s["name"]) for s in drafts.stops(draft_id)]


def test_start_is_idempotent_per_request_and_single_recording(drafts):
    r = rid()
    a = drafts.start(r, "Demo Route North", "to_school", "drv_demo", T0)
    b = drafts.start(r, "Demo Route North", "to_school", "drv_demo", T0 + 5)
    assert a["draftId"] == b["draftId"]
    assert a["status"] == "recording" and a["submission"] == "not_submitted"
    with pytest.raises(DraftError) as e:
        drafts.start(rid(), "Other", "from_school", "drv_demo", T0)
    assert e.value.code == "ALREADY_RECORDING"


@pytest.mark.parametrize(
    "bad", [{"direction": "north"}, {"name": ""}, {"name": "x" * 61}, {"request_id": "1"}]
)
def test_start_validates_input(drafts, bad):
    args = {"request_id": rid(), "name": "Demo", "direction": "to_school", **bad}
    with pytest.raises(DraftError):
        drafts.start(args["request_id"], args["name"], args["direction"], "drv_demo", T0)


def test_stops_get_service_assigned_order_and_default_names(drafts, recording):
    drafts.mark_stop(recording, rid(), None, fix(1), "drv_demo")
    drafts.mark_stop(recording, rid(), "  Maple   Ave  ", fix(2), "drv_demo")
    drafts.mark_stop(recording, rid(), "", fix(3), "drv_demo")
    assert names(drafts, recording) == [(1, "Stop 1"), (2, "Maple Ave"), (3, "Stop 3")]


def test_double_tap_mark_stop_makes_one_stop(drafts, recording):
    r = rid()
    a = drafts.mark_stop(recording, r, "Oak St", fix(1), "drv_demo")
    b = drafts.mark_stop(recording, r, "Oak St", fix(5), "drv_demo")
    assert a == b
    assert len(drafts.stops(recording)) == 1
    assert a["latitude"] == fix(1).latitude  # the retry did not move it


def test_stop_coordinates_come_from_the_fix(drafts, recording):
    s = drafts.mark_stop(recording, rid(), "Oak St", fix(7), "drv_demo")
    assert (s["latitude"], s["longitude"], s["capturedAtMs"]) == (
        fix(7).latitude,
        -83.98,
        fix(7).captured_at_ms,
    )


def test_move_and_remove_keep_a_dense_order(drafts, recording):
    ids = [
        drafts.mark_stop(recording, rid(), f"S{i}", fix(i), "drv_demo")["stopId"]
        for i in range(1, 5)
    ]
    drafts.move_stop(recording, ids[3], 1)  # S4 to the front
    assert [n for _, n in names(drafts, recording)] == ["S4", "S1", "S2", "S3"]
    drafts.move_stop(recording, ids[3], 4)  # and to the back
    assert [n for _, n in names(drafts, recording)] == ["S1", "S2", "S3", "S4"]
    drafts.remove_stop(recording, ids[1])
    assert names(drafts, recording) == [(1, "S1"), (2, "S3"), (3, "S4")]
    # A new stop goes after the last, never into a hole.
    drafts.mark_stop(recording, rid(), "S5", fix(9), "drv_demo")
    assert names(drafts, recording)[-1] == (4, "S5")


@pytest.mark.parametrize("pos", [0, 5, -1, "2", True, 1.5])
def test_move_rejects_bad_positions(drafts, recording, pos):
    ids = [
        drafts.mark_stop(recording, rid(), f"S{i}", fix(i), "drv_demo")["stopId"]
        for i in range(1, 5)
    ]
    with pytest.raises(DraftError):
        drafts.move_stop(recording, ids[0], pos)
    assert [n for _, n in names(drafts, recording)] == ["S1", "S2", "S3", "S4"]


def test_stops_from_another_draft_cannot_be_edited(drafts, recording):
    s = drafts.mark_stop(recording, rid(), "Oak St", fix(1), "drv_demo")
    drafts.finish(recording, T0 + 60_000)
    other = drafts.start(rid(), "Demo Route South", "from_school", "drv_demo", T0)["draftId"]
    with pytest.raises(DraftError):
        drafts.rename_stop(other, s["stopId"], "Hijack")
    with pytest.raises(DraftError):
        drafts.remove_stop(other, s["stopId"])


# ── Road-following path (owner decision: no snapping, so points follow the road) ──

M_PER_DEG = 111_195.0  # metres per degree of latitude


class Drive:
    """Fictional 1 Hz fixes along a path given in metres east/north of a
    fictional origin, with the receiver's course as heading."""

    LAT0, LON0 = 34.1, -83.98

    def __init__(self) -> None:
        self.t = T0
        self.x = self.y = 0.0

    def fix(self, speed: float, heading: float | None) -> Fix:
        import math

        lat = self.LAT0 + self.y / M_PER_DEG
        lon = self.LON0 + self.x / (M_PER_DEG * math.cos(math.radians(self.LAT0)))
        return Fix(self.t, lat, lon, speed, heading, 5.0, 3)

    def go(self, drafts, draft_id, heading: float, metres: float, speed: float = 10.0):
        import math

        steps = round(metres / speed)
        for _ in range(steps):
            self.t += 1000
            self.x += speed * math.sin(math.radians(heading))
            self.y += speed * math.cos(math.radians(heading))
            drafts.add_point(draft_id, self.fix(speed, heading))

    def stop(self, drafts, draft_id, seconds: int):
        for _ in range(seconds):
            self.t += 1000
            drafts.add_point(draft_id, self.fix(0.2, None))


def xy_of(p):
    import math

    return (
        (p["longitude"] - Drive.LON0) * M_PER_DEG * math.cos(math.radians(Drive.LAT0)),
        (p["latitude"] - Drive.LAT0) * M_PER_DEG,
    )


def test_spacing_is_at_most_25m_on_a_straight(drafts, recording):
    d = Drive()
    drafts.add_point(recording, d.fix(10.0, 0.0))
    d.go(drafts, recording, 0.0, 1000)
    pts = [xy_of(p) for p in drafts.detail(recording)["path"]]
    steps = [abs(b[1] - a[1]) for a, b in itertools.pairwise(pts)]
    assert max(steps) <= 25.001  # never more than 25 m between points
    assert 40 <= len(pts) <= 55


def test_l_shaped_turn_keeps_its_corner(drafts, recording):
    d = Drive()
    drafts.add_point(recording, d.fix(10.0, 0.0))
    d.go(drafts, recording, 0.0, 210, speed=15.0)  # north; corner not on the 25 m grid
    corner = (d.x, d.y)
    d.go(drafts, recording, 90.0, 210, speed=15.0)  # then east
    pts = [xy_of(p) for p in drafts.detail(recording)["path"]]
    nearest = min(((x - corner[0]) ** 2 + (y - corner[1]) ** 2) ** 0.5 for x, y in pts)
    assert nearest < 1.0  # a saved point sits on the corner itself
    # No segment cuts the corner: every point is on one leg or the other.
    for x, y in pts:
        assert abs(x) < 1.0 or abs(y - corner[1]) < 1.0


def test_no_points_while_stopped(drafts, recording):
    d = Drive()
    drafts.add_point(recording, d.fix(10.0, 0.0))
    d.go(drafts, recording, 0.0, 100)
    before = drafts.detail(recording)["pointCount"]
    d.stop(drafts, recording, 120)  # two minutes at a stop, GPS jitter only
    assert drafts.detail(recording)["pointCount"] == before
    d.go(drafts, recording, 0.0, 50)
    detail = drafts.detail(recording)
    assert detail["gapCount"] == 0  # stopping is not a GPS gap


def test_gps_gap_is_flagged_from_the_last_fix_seen(drafts, recording):
    d = Drive()
    drafts.add_point(recording, d.fix(10.0, 0.0))
    d.go(drafts, recording, 0.0, 50)
    d.t += GAP_MS + 1000  # no fixes at all (tunnel)
    d.y += 80
    d.go(drafts, recording, 0.0, 50)
    path = drafts.detail(recording)["path"]
    assert sum(p["gapBefore"] for p in path) == 1


def test_points_keep_capture_order(drafts, recording):
    d = Drive()
    assert drafts.add_point(recording, d.fix(10.0, 0.0))
    assert not drafts.add_point(recording, d.fix(10.0, 0.0))  # same fix again
    d.t -= 5000
    assert not drafts.add_point(recording, d.fix(10.0, 0.0))  # older


def test_long_route_stays_under_the_cap_and_keeps_every_corner(drafts, recording):
    from itssb_device.drafts import MAX_ROUTE_PATH_POINTS

    d = Drive()
    drafts.add_point(recording, d.fix(10.0, 0.0))
    corners = []
    # 70 km of 1 km blocks with a turn after each: ~2,800 points before thinning.
    for leg in range(70):
        heading = 0.0 if leg % 2 == 0 else 90.0
        d.go(drafts, recording, heading, 1000)
        corners.append((d.x, d.y))
    path = drafts.detail(recording)["path"]
    assert len(path) <= MAX_ROUTE_PATH_POINTS
    pts = [xy_of(p) for p in path]
    for cx, cy in corners[:-1]:
        assert min(((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 for x, y in pts) < 1.0
    # Thinned straights stay under the review's 100 m gap warning.
    longest = max(
        ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5 for a, b in itertools.pairwise(pts)
    )
    assert longest < 100


def test_thinning_a_1km_straight_keeps_few_points():
    from itssb_device.route_geometry import simplify

    pts = [(34.1 + i * 25 / M_PER_DEG, -83.98) for i in range(41)]  # 1 km, every 25 m
    assert simplify(pts, 3.0) == [0, 40]
    # With the 90 m segment limit the recorder uses: still few, none over 90 m.
    kept = simplify(pts, 3.0, max_segment_m=90.0)
    assert len(kept) <= 17 and max(b - a for a, b in itertools.pairwise(kept)) * 25 <= 90
    # A corner in the middle is never thinned away, even when protected only.
    bent = pts[:21] + [(pts[20][0], -83.98 + i * 0.00027) for i in range(1, 21)]
    keep = simplify(bent, 3.0, protected={20})
    assert 20 in keep and len(keep) <= 4


def test_finish_stops_sampling_and_marking(drafts, recording):
    drafts.add_point(recording, fix(0))
    s = drafts.finish(recording, T0 + 60_000)
    assert s["status"] == "finished" and s["finishedAtMs"] == T0 + 60_000
    assert drafts.finish(recording, T0 + 99_000)["finishedAtMs"] == T0 + 60_000
    assert not drafts.add_point(recording, fix(5))
    with pytest.raises(DraftError) as e:
        drafts.mark_stop(recording, rid(), None, fix(5), "drv_demo")
    assert e.value.code == "NOT_RECORDING"
    assert drafts.recording() is None


def test_draft_survives_restart(tmp_path):
    path = tmp_path / "d.sqlite3"
    db = Database(path)
    d = Drafts(db)
    draft = d.start(rid(), "Demo Route North", "to_school", "drv_demo", T0)["draftId"]
    d.mark_stop(draft, rid(), "Oak St", fix(1), "drv_demo")
    db.close()
    db2 = Database(path)
    d2 = Drafts(db2)
    rec = d2.recording()
    assert rec is not None and rec["draftId"] == draft and rec["stopCount"] == 1
    db2.close()


def test_sampler_records_only_fresh_fixes_while_recording(tmp_path):
    import threading

    from itssb_device.drafts import DraftSamplerThread
    from itssb_device.motion import ObservedFixHolder

    now = [100.0]
    latest = ObservedFixHolder()
    db = Database(tmp_path / "d.sqlite3")
    d = Drafts(db)
    sampler = DraftSamplerThread(
        tmp_path / "d.sqlite3", latest, threading.Event(), monotonic=lambda: now[0]
    )
    latest.set(fix(1), now[0])
    assert sampler.tick(d) is False  # nothing recording
    draft = d.start(rid(), "Demo Route North", "to_school", "drv_demo", T0)["draftId"]
    assert sampler.tick(d) is True
    assert sampler.tick(d) is False  # same fix, not saved twice
    now[0] += 6  # fix is stale
    assert sampler.tick(d) is False
    assert d.summary(draft)["pointCount"] == 1
    db.close()
