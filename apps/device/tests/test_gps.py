import json

import pytest

from itssb_device.gps import MAX_LINE_BYTES, Rejected, fix_from_tpv, parse_line

TPV = {
    "class": "TPV",
    "mode": 3,
    "time": "2026-11-25T12:18:05.000Z",
    "lat": 34.1,
    "lon": -83.98,
    "speed": 7.2,
    "track": 95.0,
    "eph": 4.5,
}


def test_valid_tpv_becomes_fix():
    fix = fix_from_tpv(TPV)
    assert fix.fix_mode == 3
    assert fix.latitude == 34.1
    assert fix.captured_at_ms == 1795609085000
    assert fix.horizontal_accuracy_m == 4.5


@pytest.mark.parametrize("mode", [0, 1, None])
def test_no_fix_is_rejected(mode):
    with pytest.raises(Rejected, match="no fix"):
        fix_from_tpv({**TPV, "mode": mode})


def test_missing_time_is_rejected_not_invented():
    report = {k: v for k, v in TPV.items() if k != "time"}
    with pytest.raises(Rejected, match="missing time"):
        fix_from_tpv(report)


@pytest.mark.parametrize("lat", [91, float("nan"), "34.1", None])
def test_invalid_coordinates_rejected(lat):
    with pytest.raises(Rejected, match="invalid coordinates"):
        fix_from_tpv({**TPV, "lat": lat})


def test_missing_optional_fields_stay_null():
    report = {k: v for k, v in TPV.items() if k not in ("speed", "track", "eph")}
    fix = fix_from_tpv(report)
    assert (fix.speed_mps, fix.heading_degrees, fix.horizontal_accuracy_m) == (None, None, None)


def test_parse_line_rejects_oversized_and_malformed():
    assert parse_line(b"{" + b" " * MAX_LINE_BYTES + b"}") is None
    assert parse_line(b"not json") is None
    assert parse_line(b"[1,2]") is None
    assert parse_line(json.dumps(TPV)) == TPV
