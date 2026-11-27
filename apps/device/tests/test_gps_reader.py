import socket

import pytest
from conftest import wait_until

from itssb_device.devtools.fake_gpsd import FakeGpsd
from itssb_device.gps_reader import GpsReader, LatestFixHolder, LineBuffer
from itssb_device.status import GPS_FRESH_S, StatusBoard


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _reader(port, stop, board=None):
    board = board or StatusBoard("boot", upload_enabled=False)
    latest = LatestFixHolder()
    r = GpsReader("127.0.0.1", port, board, latest, stop)
    r.start()
    return r, board, latest


def test_line_buffer_drops_oversized_lines_and_keeps_going():
    buf = LineBuffer(limit=10)
    assert buf.feed(b'{"a":1}\n{"b":') == [b'{"a":1}']
    assert buf.feed(b"x" * 50) == []  # oversized partial line is discarded, not grown
    assert buf.feed(b'tail}\n{"c":3}\n') == [b'{"c":3}']
    assert buf.dropped == 1


def test_no_fix_from_gpsd_is_reported_as_no_fix(fake_gpsd, stop_event):
    srv = fake_gpsd("nofix")
    _, board, latest = _reader(srv.port, stop_event)
    assert wait_until(lambda: board.snapshot()["gps"]["lastRejectReason"] == "no fix")
    gps = board.snapshot()["gps"]
    assert gps["gpsd"] == "connected"
    assert gps["status"] == "no_fix"
    assert gps["lastValidFixCapturedAtMs"] is None
    assert latest.get() is None  # nothing invented


def test_fix_is_valid_and_published(fake_gpsd, stop_event):
    srv = fake_gpsd("fix")
    _, board, latest = _reader(srv.port, stop_event)
    assert wait_until(lambda: board.snapshot()["gps"]["status"] == "valid")
    assert latest.get().fix.fix_mode == 3
    assert "latitude" not in str(board.snapshot())  # health never carries coordinates


def test_missing_receiver(fake_gpsd, stop_event):
    srv = fake_gpsd("nodevice")
    _, board, _ = _reader(srv.port, stop_event)
    assert wait_until(lambda: board.snapshot()["gps"]["status"] == "receiver_missing")


def test_gpsd_down_is_unknown_not_no_fix(stop_event):
    _, board, _ = _reader(_free_port(), stop_event)
    assert wait_until(lambda: board.snapshot()["gps"]["gpsd"] == "unreachable")
    assert board.snapshot()["gps"]["status"] == "unknown"


def test_reconnects_when_gpsd_comes_back(fake_gpsd, stop_event):
    srv = fake_gpsd("nofix")
    port = srv.port
    _, board, _ = _reader(port, stop_event)
    assert wait_until(lambda: board.snapshot()["gps"]["gpsd"] == "connected")
    srv.stop()
    assert wait_until(lambda: board.snapshot()["gps"]["gpsd"] == "unreachable")
    back = FakeGpsd(port, "fix", 0.05).start()  # same port, like a GPSD restart
    try:
        assert wait_until(lambda: board.snapshot()["gps"]["status"] == "valid", timeout=8)
    finally:
        back.stop()


def test_valid_fix_goes_stale(clock):
    board = StatusBoard("boot", upload_enabled=False, monotonic=clock)
    board.gpsd_state("connected")
    board.gps_receivers(1)
    board.gps_fix(1795609085000, 3)
    assert board.snapshot()["gps"]["status"] == "valid"
    clock.advance(GPS_FRESH_S + 0.1)
    snap = board.snapshot()["gps"]
    assert snap["status"] == "no_fix"
    assert snap["lastValidFixAgeMs"] >= GPS_FRESH_S * 1000  # age kept, not hidden


def _tpv(time_iso):
    import json as _json

    return _json.dumps(
        {"class": "TPV", "mode": 3, "time": time_iso, "lat": 34.1, "lon": -83.98}
    ).encode()


def test_repeated_or_old_reports_do_not_look_fresh(clock, stop_event):
    now_ms = 1_795_609_085_000  # 2026-11-25T12:18:05Z
    board = StatusBoard("boot", upload_enabled=False, monotonic=clock)
    board.gpsd_state("connected")
    board.gps_receivers(1)
    latest = LatestFixHolder()
    reader = GpsReader(
        "127.0.0.1", 1, board, latest, stop_event, monotonic=clock, now_ms=lambda: now_ms
    )
    reader.handle_line(_tpv("2026-11-25T12:18:05.000Z"))
    assert board.snapshot()["gps"]["status"] == "valid"
    # The same epoch repeated for a minute must not keep GPS "valid".
    for _ in range(60):
        clock.advance(1)
        reader.handle_line(_tpv("2026-11-25T12:18:05.000Z"))
    assert board.snapshot()["gps"]["status"] == "no_fix"
    assert board.snapshot()["gps"]["lastValidFixAgeMs"] >= 60_000


@pytest.mark.parametrize(
    ("time_iso", "reason"),
    [
        ("2026-11-25T11:18:05.000Z", "capture time too old"),
        ("2026-11-26T12:18:05.000Z", "capture time in the future"),
    ],
)
def test_implausible_capture_times_are_rejected(clock, stop_event, time_iso, reason):
    board = StatusBoard("boot", upload_enabled=False, monotonic=clock)
    latest = LatestFixHolder()
    reader = GpsReader(
        "127.0.0.1", 1, board, latest, stop_event, monotonic=clock, now_ms=lambda: 1_795_609_085_000
    )
    reader.handle_line(_tpv(time_iso))
    assert latest.get() is None
    assert board.snapshot()["gps"]["lastRejectReason"] == reason
