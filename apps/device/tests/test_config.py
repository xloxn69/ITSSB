from pathlib import Path

import pytest

from itssb_device.config import ConfigError, load_config, parse_env_file

FAKE_TOKEN = "fake-token-for-tests-0000"  # noqa: S105 - obviously fake


def test_defaults_without_any_settings(tmp_path):
    cfg = load_config({}, env_file=tmp_path / "missing.env")
    assert cfg.local_api_host == "127.0.0.1"
    assert cfg.local_api_port == 8765
    assert (cfg.gpsd_host, cfg.gpsd_port) == ("127.0.0.1", 2947)
    assert cfg.upload_enabled is False  # no origin, no token: uploads disabled, not a crash


def test_token_is_never_in_repr_or_redacted_view():
    cfg = load_config(
        {
            "ITSSB_DEVICE_TOKEN": FAKE_TOKEN,
            "ITSSB_DEVICE_API_ORIGIN": "https://demo.example.invalid",
        }
    )
    assert FAKE_TOKEN not in repr(cfg)
    assert FAKE_TOKEN not in str(cfg.redacted())
    assert cfg.upload_enabled


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.5", "example.com", "::"])  # noqa: S104
def test_local_api_must_be_loopback(host):
    with pytest.raises(ConfigError, match="loopback"):
        load_config({"ITSSB_LOCAL_API_HOST": host})


@pytest.mark.parametrize(
    "origin",
    [
        "http://demo.example.invalid",  # plain http off-box
        "ftp://demo.example.invalid",
        "https://demo.example.invalid/device/v1",  # path
        "https://user:pw@demo.example.invalid",
        "https://REPLACE_WITH_DEVICE_HTTP_ORIGIN",
    ],
)
def test_bad_origins_are_refused(origin):
    with pytest.raises(ConfigError):
        load_config({"ITSSB_DEVICE_API_ORIGIN": origin})


def test_http_allowed_for_local_fake_backend():
    cfg = load_config({"ITSSB_DEVICE_API_ORIGIN": "http://127.0.0.1:9999/"})
    assert cfg.device_api_origin == "http://127.0.0.1:9999"


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("ITSSB_PUBLISH_INTERVAL_SECONDS", "0"),
        ("ITSSB_PUBLISH_INTERVAL_SECONDS", "nan"),
        ("ITSSB_LOCAL_API_PORT", "70000"),
        ("ITSSB_MAX_BATCH_EVENTS", "500"),
        ("ITSSB_GPSD_PORT", "abc"),
    ],
)
def test_impossible_values_are_refused(key, value):
    with pytest.raises(ConfigError, match=key):
        load_config({key: value})


def test_placeholder_token_is_refused_and_message_has_no_token():
    with pytest.raises(ConfigError) as info:
        load_config({"ITSSB_DEVICE_TOKEN": "REPLACE_ME"})
    assert "REPLACE_ME" not in str(info.value)


def test_env_file_parsing_and_environment_precedence(tmp_path):
    f = tmp_path / "device.env"
    f.write_text(
        "# comment\n"
        "ITSSB_GPSD_PORT=2948\n"
        "ITSSB_DEVICE_API_ORIGIN='http://127.0.0.1:9999'\n"
        f'ITSSB_DEVICE_TOKEN="{FAKE_TOKEN}"\n'
    )
    f.chmod(0o600)
    cfg = load_config({"ITSSB_GPSD_PORT": "3000"}, env_file=f)
    assert cfg.gpsd_port == 3000  # process environment wins
    assert cfg.device_api_origin == "http://127.0.0.1:9999"
    assert cfg.device_token == FAKE_TOKEN


def test_env_file_rejects_garbage():
    with pytest.raises(ConfigError, match="line 2"):
        parse_env_file("A=1\nnot a setting\n")


def test_unreadable_env_file_falls_back_to_environment(tmp_path, monkeypatch):
    f = tmp_path / "device.env"
    f.write_text("ITSSB_GPSD_PORT=2948\n")

    def deny(*_a, **_k):
        raise PermissionError

    monkeypatch.setattr(type(f), "read_text", deny)
    assert load_config({}, env_file=f).gpsd_port == 2947


def test_example_file_parses_but_its_placeholders_are_refused():
    example = Path(__file__).parent.parent / "deploy" / "device.env.example"
    values = parse_env_file(example.read_text())
    assert set(values) == {"ITSSB_DEVICE_API_ORIGIN", "ITSSB_DEVICE_TOKEN"}
    with pytest.raises(ConfigError, match="placeholder"):
        load_config({}, env_file=example)
