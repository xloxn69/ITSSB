import socket

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
