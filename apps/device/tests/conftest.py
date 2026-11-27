import threading
import time

import pytest

from itssb_device.devtools.fake_gpsd import FakeGpsd


class FakeClock:
    """Manually advanced monotonic clock."""

    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def fake_gpsd():
    servers = []

    def make(mode="fix", interval_s=0.05):
        s = FakeGpsd(0, mode, interval_s).start()
        servers.append(s)
        return s

    yield make
    for s in servers:
        s.stop()


def wait_until(predicate, timeout=5.0, interval=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


@pytest.fixture
def stop_event():
    e = threading.Event()
    yield e
    e.set()
