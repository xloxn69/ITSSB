"""Guards on the shipped systemd unit (installed by the owner, see deploy/INSTALL.md)."""

import configparser
from pathlib import Path

DEPLOY = Path(__file__).parent.parent / "deploy"


def _unit():
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    parser.optionxform = str  # keep key case
    parser.read(DEPLOY / "itssb-device.service")
    return parser


def test_unit_runs_unprivileged_with_optional_env_file():
    svc = _unit()["Service"]
    assert svc["User"] == "itssb"
    assert svc["EnvironmentFile"] == "-/etc/itssb/device.env"
    assert svc["ExecStart"] == "/usr/bin/python3 -m itssb_device run"
    assert svc["NoNewPrivileges"] == "yes"
    assert svc["ProtectSystem"] == "strict"
    assert svc["StateDirectory"] == "itssb"


def test_unit_stops_cleanly_and_does_not_loop_on_bad_config():
    svc = _unit()["Service"]
    assert svc["KillSignal"] == "SIGTERM"
    assert int(svc["TimeoutStopSec"]) >= 20  # service joins threads within 15 s
    assert svc["RestartPreventExitStatus"] == "2"  # ConfigError exit code


def test_gpsd_is_wanted_not_required():
    unit = _unit()["Unit"]
    assert "gpsd.socket" in unit["Wants"]
    assert "Requires" not in unit


def test_unit_pythonpath_points_at_the_package():
    text = (DEPLOY / "itssb-device.service").read_text()
    assert "Environment=PYTHONPATH=/opt/itssb/current/src\n" in text
    assert (Path(__file__).parent.parent / "src" / "itssb_device" / "__main__.py").exists()
