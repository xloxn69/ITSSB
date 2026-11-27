from itssb_device.models import Fix
from itssb_device.motion import MotionJudge, ObservedFixHolder


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def setup():
    clock = Clock()
    latest = ObservedFixHolder()
    latest.judge = MotionJudge(latest, monotonic=clock)
    return clock, latest, latest.judge


def fix(speed):
    # Fictional coordinates (docs/08 examples).
    return Fix(1_795_608_000_000, 34.1, -83.98, speed, 0.0, 6.0, 3)


def test_no_fix_is_unknown_and_cannot_be_parked():
    _, _, judge = setup()
    assert judge.state() == "unknown"
    assert judge.confirm_parked() is False
    assert judge.snapshot()["parked"] is False


def test_moving_fix_cannot_be_confirmed_parked():
    clock, latest, judge = setup()
    latest.set(fix(6.0), clock.t)
    assert judge.state() == "moving"
    assert judge.confirm_parked() is False


def test_missing_speed_is_unknown_not_stopped():
    clock, latest, judge = setup()
    latest.set(fix(None), clock.t)
    assert judge.state() == "unknown"


def test_low_speed_alone_is_not_parked():
    clock, latest, judge = setup()
    latest.set(fix(0.1), clock.t)
    assert judge.state() == "stopped"
    assert judge.snapshot()["parked"] is False


def test_confirmed_stop_parks_until_movement():
    clock, latest, judge = setup()
    latest.set(fix(0.1), clock.t)
    assert judge.confirm_parked() is True
    assert judge.parked() is True
    clock.t += 1
    latest.set(fix(4.0), clock.t)
    assert judge.parked() is False
    # Stopping again does not re-park by itself.
    clock.t += 1
    latest.set(fix(0.0), clock.t)
    assert judge.parked() is False


def test_losing_the_fix_unparks():
    clock, latest, judge = setup()
    latest.set(fix(0.0), clock.t)
    judge.confirm_parked()
    clock.t += 6  # fix older than the freshness window
    assert judge.state() == "unknown"
    assert judge.parked() is False
    # And it stays unparked when a fresh stopped fix returns.
    latest.set(fix(0.0), clock.t)
    assert judge.parked() is False


def test_unpark_is_sticky_even_if_nobody_looked_while_moving():
    clock, latest, judge = setup()
    latest.set(fix(0.0), clock.t)
    judge.confirm_parked()
    clock.t += 1
    latest.set(fix(8.0), clock.t)  # nobody reads motion during this fix
    clock.t += 1
    latest.set(fix(0.0), clock.t)
    assert judge.parked() is False


def test_walking_pace_jitter_is_still_stopped():
    clock, latest, judge = setup()
    latest.set(fix(0.4), clock.t)
    assert judge.state() == "stopped"


def test_a_fix_gap_nobody_saw_still_unparks():
    clock, latest, judge = setup()
    latest.set(fix(0.0), clock.t)
    judge.confirm_parked()
    clock.t += 30  # no fixes for 30 s (tunnel, unplugged), and no reads
    latest.set(fix(0.0), clock.t)
    assert judge.parked() is False


def test_gpsd_no_fix_report_ends_parked_immediately():
    """Review finding: a mode-1 report left the last stopped fix authoritative,
    so Parked (and editing) survived until the fix aged out."""
    import json
    import threading

    from itssb_device.gps_reader import GpsReader
    from itssb_device.status import StatusBoard

    clock, latest, judge = setup()
    reader = GpsReader(
        "127.0.0.1",
        1,
        StatusBoard("b", upload_enabled=False),
        latest,
        threading.Event(),
        monotonic=clock,
    )
    latest.set(fix(0.0), clock.t)
    assert judge.confirm_parked() is True
    clock.t += 1
    reader.handle_line(json.dumps({"class": "TPV", "mode": 1}).encode())
    assert latest.get() is None
    assert judge.parked() is False
    # A stopped fix returning a moment later does not restore it.
    latest.set(fix(0.0), clock.t + 1)
    assert judge.parked() is False


def test_receiver_unplugged_ends_parked():
    import json
    import threading

    from itssb_device.gps_reader import GpsReader
    from itssb_device.status import StatusBoard

    clock, latest, judge = setup()
    reader = GpsReader(
        "127.0.0.1",
        1,
        StatusBoard("b", upload_enabled=False),
        latest,
        threading.Event(),
        monotonic=clock,
    )
    latest.set(fix(0.0), clock.t)
    judge.confirm_parked()
    reader.handle_line(json.dumps({"class": "DEVICES", "devices": []}).encode())
    assert judge.parked() is False
