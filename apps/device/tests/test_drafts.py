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


def test_points_keep_capture_order_and_flag_gaps(drafts, recording):
    assert drafts.add_point(recording, fix(0))
    assert drafts.add_point(recording, fix(1))
    assert not drafts.add_point(recording, fix(1))  # same fix again: not saved twice
    assert not drafts.add_point(recording, fix(0))  # older: not saved
    assert drafts.add_point(recording, fix(0, at_ms=T0 + 1000 + GAP_MS + 1))
    d = drafts.detail(recording)
    assert d["pointCount"] == 3
    assert d["gapCount"] == 1
    assert [p["gapBefore"] for p in d["path"]] == [False, False, True]


def test_review_path_is_bounded_but_keeps_gaps(drafts, recording):
    for i in range(1000):
        drafts.add_point(recording, fix(i))
    drafts.add_point(recording, fix(0, at_ms=T0 + 2_000_000))
    path = drafts.detail(recording)["path"]
    assert len(path) <= 402
    assert path[-1]["gapBefore"] is True


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
