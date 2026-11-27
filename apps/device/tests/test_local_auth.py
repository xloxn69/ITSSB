import json

import pytest

from itssb_device.local_auth import (
    DRIVER_SESSION_MAX_S,
    FREE_ATTEMPTS,
    Driver,
    SessionManager,
    UnlockResult,
    allowed_origins,
    check_protected_read,
    check_state_change,
    hash_pin,
    load_drivers,
    read_cookie,
    verify_pin,
)

ORIGINS = allowed_origins(8765)
GOOD = {"Origin": "http://127.0.0.1:8765", "Content-Type": "application/json"}


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture(scope="module")
def demo_hash():
    return hash_pin("482916")  # fictional test PIN


def manager(demo_hash, clock=None):
    drivers = {"drv_demo": Driver("drv_demo", "Demo Driver", demo_hash)}
    return SessionManager(drivers, monotonic=clock or Clock())


@pytest.mark.parametrize(
    "headers",
    [
        {"Content-Type": "application/json"},  # no Origin
        {**GOOD, "Origin": "null"},
        {**GOOD, "Origin": "http://127.0.0.1:9999"},  # same site, other port
        {**GOOD, "Origin": "http://evil.example"},
        {**GOOD, "Origin": "https://127.0.0.1:8765"},
        {**GOOD, "Sec-Fetch-Site": "same-site"},
        {**GOOD, "Sec-Fetch-Site": "cross-site"},
        {**GOOD, "Content-Type": "text/plain"},  # a "simple" cross-site form post
        {**GOOD, "Content-Type": "application/x-www-form-urlencoded"},
    ],
)
def test_state_change_refuses_anything_but_this_origin(headers):
    assert check_state_change(headers, ORIGINS) is not None


def test_state_change_accepts_the_driver_ui():
    assert check_state_change(GOOD, ORIGINS) is None
    assert check_state_change({**GOOD, "Sec-Fetch-Site": "same-origin"}, ORIGINS) is None
    loc = {**GOOD, "Origin": "http://localhost:8765"}
    assert check_state_change(loc, ORIGINS) is None


def test_protected_read_refuses_cross_site_fetches():
    assert check_protected_read({"Sec-Fetch-Site": "cross-site"}) is not None
    assert check_protected_read({"Sec-Fetch-Site": "same-site"}) is not None
    assert check_protected_read({"Sec-Fetch-Site": "same-origin"}) is None


def test_read_cookie():
    assert read_cookie("a=1; itssb_kiosk=abc; b=2") == "abc"
    assert read_cookie("itssb_kiosk=") is None
    assert read_cookie(None) is None


def test_pin_hash_roundtrip_and_no_plaintext(demo_hash):
    assert "482916" not in demo_hash
    assert verify_pin("482916", demo_hash)
    assert not verify_pin("482917", demo_hash)
    assert not verify_pin("482916", "plain$482916")


def test_unlock_and_lock(demo_hash):
    m = manager(demo_hash)
    s = m.new_session()
    assert m.unlock(s, "drv_demo", "482916") == UnlockResult.OK
    assert s.driver is not None
    m.lock(s)
    assert s.driver is None


def test_csrf_is_per_session(demo_hash):
    m = manager(demo_hash)
    a, b = m.new_session(), m.new_session()
    assert m.csrf_ok(a, a.csrf)
    assert not m.csrf_ok(a, b.csrf)
    assert not m.csrf_ok(a, None)


def test_wrong_pins_lock_out_the_device_even_for_the_right_pin(demo_hash):
    clock = Clock()
    m = manager(demo_hash, clock)
    s = m.new_session()
    for _ in range(FREE_ATTEMPTS):
        assert m.unlock(s, "drv_demo", "111111") == UnlockResult.WRONG
    assert m.unlock(s, "drv_demo", "482916") == UnlockResult.LOCKED_OUT
    assert s.driver is None
    # A new kiosk session (reload) does not reset the lockout.
    assert m.unlock(m.new_session(), "drv_demo", "482916") == UnlockResult.LOCKED_OUT
    clock.t += 31
    assert m.unlock(s, "drv_demo", "482916") == UnlockResult.OK


def test_lockout_grows_after_more_failures(demo_hash):
    clock = Clock()
    m = manager(demo_hash, clock)
    s = m.new_session()
    for _ in range(FREE_ATTEMPTS):
        m.unlock(s, "drv_demo", "111111")
    clock.t += 31
    m.unlock(s, "drv_demo", "111111")  # 6th failure: 60 s
    clock.t += 31
    assert m.unlock(s, "drv_demo", "482916") == UnlockResult.LOCKED_OUT


def test_unknown_driver_and_bad_input_never_unlock(demo_hash):
    m = manager(demo_hash)
    s = m.new_session()
    assert m.unlock(s, "drv_other", "482916") == UnlockResult.UNKNOWN_DRIVER
    assert m.unlock(s, "drv_demo", "48") == UnlockResult.BAD_INPUT
    assert m.unlock(s, "drv_demo", 482916) == UnlockResult.BAD_INPUT
    assert s.driver is None


def test_driver_session_expires(demo_hash):
    clock = Clock()
    m = manager(demo_hash, clock)
    s = m.new_session()
    m.unlock(s, "drv_demo", "482916")
    clock.t += DRIVER_SESSION_MAX_S + 1
    got = m.get(s.session_id)
    assert got is not None and got.driver is None


def test_drivers_file_rejects_plaintext_and_missing(tmp_path, demo_hash):
    assert load_drivers(tmp_path / "missing.json") == {}
    bad = tmp_path / "bad.json"
    bad.write_text(
        json.dumps({"drivers": [{"driverId": "d", "displayName": "D", "pinHash": "1234"}]})
    )
    assert load_drivers(bad) == {}
    good = tmp_path / "drivers.json"
    entry = {"driverId": "drv_demo", "displayName": "Demo Driver", "pinHash": demo_hash}
    good.write_text(json.dumps({"drivers": [entry]}))
    assert load_drivers(good)["drv_demo"].display_name == "Demo Driver"
