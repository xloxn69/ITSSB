"""Deliberate configuration loading (docs/04 §4).

Settings come from environment variables. Under systemd they are injected by
`EnvironmentFile=-/etc/itssb/device.env`; for development you can point
`--env-file` (or `ITSSB_ENV_FILE`) at a copy of `deploy/device.env.example`.
Values already in the process environment win over the file.

The device token is never printed: it is excluded from `repr()` and logs.
A missing token is not a crash. It disables cloud upload and shows up in
health as `backend.status = "unconfigured"`; it never grants default access.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import stat
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

log = logging.getLogger(__name__)

DEFAULT_ENV_FILE = Path("/etc/itssb/device.env")
DEFAULT_DRIVERS_FILE = Path("/etc/itssb/drivers.json")
# Built driver UI (apps/driver-ui `bun run build` output) shipped inside the package.
DEFAULT_DRIVER_UI_DIR = Path(__file__).resolve().parent / "static"
LOOPBACK_NAMES = {"localhost"}


class ConfigError(ValueError):
    """Invalid configuration. The message never contains the token."""


@dataclass(frozen=True, slots=True)
class Config:
    database_path: Path
    gpsd_host: str = "127.0.0.1"
    gpsd_port: int = 2947
    local_api_host: str = "127.0.0.1"
    local_api_port: int = 8765
    publish_interval_s: float = 5.0
    upload_interval_s: float = 5.0
    max_batch_events: int = 50
    max_batch_bytes: int = 128 * 1024
    http_timeout_s: float = 10.0
    device_api_origin: str | None = None
    device_token: str | None = field(default=None, repr=False)
    log_level: str = "INFO"
    log_file: Path | None = None
    drivers_file: Path = DEFAULT_DRIVERS_FILE
    driver_ui_dir: Path = DEFAULT_DRIVER_UI_DIR

    @property
    def upload_enabled(self) -> bool:
        return bool(self.device_api_origin and self.device_token)

    def redacted(self) -> dict[str, object]:
        """Safe to log."""
        return {
            "databasePath": str(self.database_path),
            "gpsd": f"{self.gpsd_host}:{self.gpsd_port}",
            "localApi": f"{self.local_api_host}:{self.local_api_port}",
            "publishIntervalS": self.publish_interval_s,
            "uploadIntervalS": self.upload_interval_s,
            "deviceApiOrigin": self.device_api_origin,
            "deviceToken": "<set>" if self.device_token else "<missing>",
            "logFile": str(self.log_file) if self.log_file else None,
            "driversFile": str(self.drivers_file),
            "driverUiDir": str(self.driver_ui_dir),
        }


def is_loopback(host: str) -> bool:
    if host.lower() in LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def parse_env_file(text: str) -> dict[str, str]:
    """Parses systemd-style `KEY=VALUE` lines. No shell expansion; optional
    matching single or double quotes around the value are removed."""
    values: dict[str, str] = {}
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not key.isidentifier():
            raise ConfigError(f"env file line {number}: expected KEY=VALUE")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def read_env_file(path: Path) -> dict[str, str]:
    """Reads an env file if present and readable. Under systemd the service
    user cannot read the root-owned 0600 file; that's expected, because
    systemd already injected its values into the environment."""
    try:
        st = path.stat()
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        log.info("config: %s not present; using process environment only", path)
        return {}
    except PermissionError:
        log.info("config: %s not readable by this user; using process environment", path)
        return {}
    values = parse_env_file(text)
    if values.get("ITSSB_DEVICE_TOKEN") and st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        log.warning("config: %s holds a token but is group/other accessible; use mode 0600", path)
    return values


def _int(env: Mapping[str, str], key: str, default: int, lo: int, hi: int) -> int:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer") from exc
    if not lo <= value <= hi:
        raise ConfigError(f"{key} must be between {lo} and {hi}")
    return value


def _float(env: Mapping[str, str], key: str, default: float, lo: float, hi: float) -> float:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be a number") from exc
    if not lo <= value <= hi:  # also rejects NaN
        raise ConfigError(f"{key} must be between {lo} and {hi}")
    return value


def _origin(raw: str | None) -> str | None:
    if not raw:
        return None
    parts = urlsplit(raw)
    if parts.scheme not in ("https", "http") or not parts.hostname:
        raise ConfigError("ITSSB_DEVICE_API_ORIGIN must be an http(s) origin")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ConfigError(
            "ITSSB_DEVICE_API_ORIGIN must not contain credentials, query, or fragment"
        )
    if parts.path not in ("", "/"):
        raise ConfigError("ITSSB_DEVICE_API_ORIGIN must be an origin without a path")
    if "REPLACE" in parts.hostname.upper():
        raise ConfigError("ITSSB_DEVICE_API_ORIGIN is still the example placeholder")
    if parts.scheme == "http" and not is_loopback(parts.hostname):
        raise ConfigError(
            "ITSSB_DEVICE_API_ORIGIN must use https (http is allowed only for loopback)"
        )
    try:
        _ = parts.port
    except ValueError as exc:
        raise ConfigError("ITSSB_DEVICE_API_ORIGIN has an invalid port") from exc
    return f"{parts.scheme}://{parts.netloc}"


def load_config(environ: Mapping[str, str] | None = None, env_file: Path | None = None) -> Config:
    """Builds and validates a Config. Process environment overrides the file."""
    environ = os.environ if environ is None else environ
    file_values = read_env_file(env_file) if env_file else {}
    env: dict[str, str] = {**file_values, **environ}

    local_host = env.get("ITSSB_LOCAL_API_HOST") or "127.0.0.1"
    if not is_loopback(local_host):
        raise ConfigError("ITSSB_LOCAL_API_HOST must be a loopback address")

    token = env.get("ITSSB_DEVICE_TOKEN") or None
    if token is not None and ("REPLACE" in token.upper() or any(c.isspace() for c in token)):
        raise ConfigError("ITSSB_DEVICE_TOKEN is a placeholder or contains whitespace")

    level = (env.get("ITSSB_LOG_LEVEL") or "INFO").upper()
    if level not in ("DEBUG", "INFO", "WARNING", "ERROR"):
        raise ConfigError("ITSSB_LOG_LEVEL must be DEBUG, INFO, WARNING, or ERROR")

    db_path = env.get("ITSSB_DATABASE_PATH") or "/var/lib/itssb/device.sqlite3"
    log_file = env.get("ITSSB_LOG_FILE") or None

    return Config(
        database_path=Path(db_path),
        gpsd_host=env.get("ITSSB_GPSD_HOST") or "127.0.0.1",
        gpsd_port=_int(env, "ITSSB_GPSD_PORT", 2947, 1, 65535),
        local_api_host=local_host,
        local_api_port=_int(env, "ITSSB_LOCAL_API_PORT", 8765, 1, 65535),
        publish_interval_s=_float(env, "ITSSB_PUBLISH_INTERVAL_SECONDS", 5.0, 1.0, 3600.0),
        upload_interval_s=_float(env, "ITSSB_UPLOAD_INTERVAL_SECONDS", 5.0, 1.0, 3600.0),
        max_batch_events=_int(env, "ITSSB_MAX_BATCH_EVENTS", 50, 1, 50),
        max_batch_bytes=_int(env, "ITSSB_MAX_BATCH_BYTES", 128 * 1024, 1024, 128 * 1024),
        http_timeout_s=_float(env, "ITSSB_HTTP_TIMEOUT_SECONDS", 10.0, 1.0, 120.0),
        device_api_origin=_origin(env.get("ITSSB_DEVICE_API_ORIGIN")),
        device_token=token,
        log_level=level,
        log_file=Path(log_file) if log_file else None,
        drivers_file=Path(env.get("ITSSB_DRIVERS_FILE") or DEFAULT_DRIVERS_FILE),
        driver_ui_dir=Path(env.get("ITSSB_DRIVER_UI_DIR") or DEFAULT_DRIVER_UI_DIR),
    )
