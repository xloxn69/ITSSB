"""Health names the installed release (docs/14 §1), read from RELEASE.json."""

import json

from itssb_device import release
from itssb_device.status import StatusBoard


def test_release_is_null_when_running_from_a_checkout(tmp_path, monkeypatch):
    monkeypatch.setattr(release, "RELEASE_FILE", tmp_path / "RELEASE.json")
    release.load_release.cache_clear()
    board = StatusBoard(boot_id="b", upload_enabled=False)
    assert board.snapshot()["process"]["release"] is None


def test_release_reports_version_and_source_revision(tmp_path, monkeypatch):
    path = tmp_path / "RELEASE.json"
    path.write_text(
        json.dumps(
            {
                "version": "2026.11.26-abc1234",
                "sourceRevision": "abc1234" + "0" * 33,
                "dbSchemaVersion": 2,
                "filesSha256": "f" * 64,
                "unrelated": "ignored",
            }
        )
    )
    monkeypatch.setattr(release, "RELEASE_FILE", path)
    release.load_release.cache_clear()
    board = StatusBoard(boot_id="b", upload_enabled=False)
    assert board.snapshot()["process"]["release"] == {
        "version": "2026.11.26-abc1234",
        "sourceRevision": "abc1234" + "0" * 33,
        "dbSchemaVersion": 2,
        "filesSha256": "f" * 64,
    }


def test_unreadable_release_file_is_null_not_a_crash(tmp_path, monkeypatch):
    path = tmp_path / "RELEASE.json"
    path.write_text("{not json")
    monkeypatch.setattr(release, "RELEASE_FILE", path)
    release.load_release.cache_clear()
    assert StatusBoard(boot_id="b", upload_enabled=False).snapshot()["process"]["release"] is None


def test_health_names_the_environment():
    board = StatusBoard(boot_id="b", upload_enabled=False, environment="staging")
    assert board.snapshot()["process"]["environment"] == "staging"
    assert StatusBoard(boot_id="b", upload_enabled=False).snapshot()["process"]["environment"] == (
        "development"
    )
