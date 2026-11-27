#!/usr/bin/env python3
"""ITSSB Pi release tool: stage, activate, roll back, back up, restore.

The owner runs this (with sudo for /opt/itssb and /var/lib/itssb); it never
calls sudo itself and never edits /etc. Runbook:
docs/runbooks/pi-update-and-rollback.md. Spec: docs/14 §5 and §8.

Layout under --root (default /opt/itssb):

    releases/<version>/      one immutable copy of apps/device + RELEASE.json
    current -> releases/<v>  what systemd runs (WorkingDirectory, PYTHONPATH)
    previous -> releases/<v> the rollback target
    activations.log          one JSON line per switch

The service runs the standard library with /usr/bin/python3 (no virtualenv),
so a release's code and its (empty) runtime dependency set switch together
with the one symlink. uv.lock is kept in the release as the record of the
tested development tools.

Exit status: 0 done, 1 refused (nothing changed), 2 usage error.
Standard library only; Python 3.11+.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_ROOT = Path("/opt/itssb")
DEFAULT_DB = Path("/var/lib/itssb/device.sqlite3")
DEFAULT_HEALTH = "http://127.0.0.1:8765/health"
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
RELEASE_FILES = ("pyproject.toml", "uv.lock", "README.md")
RELEASE_DIRS = ("src", "deploy")
IGNORED = shutil.ignore_patterns("__pycache__", "*.pyc", ".venv", "var", "tests")
TABLES_TO_COUNT = ("local_runs", "telemetry_events", "outbox", "run_start_requests")


class Refused(Exception):
    """A safety check failed. Nothing was changed."""


def utc_stamp() -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


# ── Health (is the service running? is a run active?) ──────────────────


def read_health(url: str) -> dict | None:
    """The local health snapshot, or None when nothing answers."""
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:  # noqa: S310 (loopback URL from the owner)
            return json.load(resp)
    except (urllib.error.URLError, OSError, ValueError):
        return None


def require_stopped(url: str) -> None:
    if read_health(url) is not None:
        raise Refused(
            f"the device service is answering at {url}; stop the service first "
            "(sudo systemctl stop itssb-device) after `preflight` passes"
        )


# ── Releases ──────────────────────────────────────────────────────────


def tree_digest(release: Path) -> str:
    """SHA-256 over every file's relative path and contents, RELEASE.json excluded."""
    h = hashlib.sha256()
    for path in sorted(p for p in release.rglob("*") if p.is_file()):
        rel = path.relative_to(release).as_posix()
        if rel == "RELEASE.json" or "__pycache__" in path.parts:
            continue
        h.update(rel.encode() + b"\0")
        h.update(hashlib.sha256(path.read_bytes()).digest())
    return h.hexdigest()


def probe_release(src: Path) -> dict:
    """Asks the release's own code for its package and database versions."""
    code = (
        "import json, sys; sys.path.insert(0, sys.argv[1]);"
        "import itssb_device as p; from itssb_device import database as d;"
        "print(json.dumps({'packageVersion': p.__version__, 'dbSchemaVersion': len(d.MIGRATIONS)}))"
    )
    out = subprocess.run(  # noqa: S603 (fixed interpreter and code)
        [sys.executable, "-I", "-c", code, str(src / "src")],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if out.returncode != 0:
        raise Refused(f"the release does not import: {out.stderr.strip()[-400:]}")
    return json.loads(out.stdout)


def release_info(root: Path, version: str) -> dict:
    path = root / "releases" / version / "RELEASE.json"
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        raise Refused(f"release {version!r} is not staged under {root / 'releases'}") from None


def verify_release(root: Path, version: str) -> dict:
    info = release_info(root, version)
    actual = tree_digest(root / "releases" / version)
    if actual != info.get("filesSha256"):
        raise Refused(
            f"release {version!r} failed its integrity check: files changed since staging "
            f"(expected {info.get('filesSha256')}, found {actual}); stage it again"
        )
    return info


def db_schema_version(db: Path) -> int | None:
    if not db.exists():
        return None
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()


def link_target(link: Path) -> str | None:
    """The release version a symlink points at, or None."""
    if not link.is_symlink():
        return None
    return Path(os.readlink(link)).name


def switch_link(link: Path, version: str) -> None:
    """Atomically points `link` at releases/<version> (relative symlink)."""
    tmp = link.with_name(link.name + ".new")
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    tmp.symlink_to(Path("releases") / version)
    os.replace(tmp, link)


def cmd_stage(args: argparse.Namespace) -> int:
    root: Path = args.root
    src = Path(args.source).resolve()
    if not VERSION_RE.match(args.version):
        raise Refused("version must be 1-64 characters of letters, digits, '.', '_' or '-'")
    if not (src / "src" / "itssb_device" / "__main__.py").is_file():
        raise Refused(f"{src} is not an apps/device checkout (no src/itssb_device)")
    final = root / "releases" / args.version
    if final.exists():
        raise Refused(f"release {args.version!r} is already staged; use a new version")
    staging = root / "releases" / f".{args.version}.staging"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    for d in RELEASE_DIRS:
        if (src / d).is_dir():
            shutil.copytree(src / d, staging / d, ignore=IGNORED)
    for f in RELEASE_FILES:
        if (src / f).is_file():
            shutil.copy2(src / f, staging / f)
    probe = probe_release(staging)
    info = {
        "version": args.version,
        "sourceRevision": args.revision,
        "packageVersion": probe["packageVersion"],
        "dbSchemaVersion": probe["dbSchemaVersion"],
        "requiresPython": ">=3.11",
        "runtimeDependencies": [],
        "stagedAtMs": time.time_ns() // 1_000_000,
        "filesSha256": tree_digest(staging),
    }
    (staging / "RELEASE.json").write_text(json.dumps(info, indent=2) + "\n")
    for path in staging.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)
    staging.rename(final)
    digest, schema = info["filesSha256"][:12], info["dbSchemaVersion"]
    print(f"staged {args.version} ({digest}, db schema {schema})")
    print("not active yet: run `preflight`, stop the service, `backup`, then `activate`")
    return 0


def activate(args: argparse.Namespace, version: str, verb: str) -> int:
    root: Path = args.root
    require_stopped(args.health_url)
    info = verify_release(root, version)
    db: Path = args.db
    db_version = db_schema_version(db)
    if db_version is not None and db_version > info["dbSchemaVersion"] and not args.accept_newer_db:
        raise Refused(
            f"the database at {db} is at schema {db_version}, but release {version!r} only "
            f"knows {info['dbSchemaVersion']}; it may not read the newer format. Restore the "
            "pre-update backup instead, or pass --accept-newer-db only if the newer "
            "migrations are documented as additive"
        )
    current = root / "current"
    before = link_target(current)
    if before == version:
        print(f"{version} is already current; nothing changed")
        return 0
    switch_link(current, version)
    if before:
        switch_link(root / "previous", before)
    entry = {"atMs": time.time_ns() // 1_000_000, "action": verb, "from": before, "to": version}
    with (root / "activations.log").open("a") as log:
        log.write(json.dumps(entry) + "\n")
    print(f"{verb}: current {before or '(none)'} -> {version}")
    print("start the service, then check health shows this release (see the runbook)")
    return 0


def cmd_activate(args: argparse.Namespace) -> int:
    return activate(args, args.version, "activate")


def cmd_rollback(args: argparse.Namespace) -> int:
    previous = link_target(args.root / "previous")
    if not previous:
        raise Refused("no previous release to roll back to")
    return activate(args, previous, "rollback")


def cmd_status(args: argparse.Namespace) -> int:
    root: Path = args.root
    releases = sorted(p.name for p in (root / "releases").glob("*") if not p.name.startswith("."))
    print(f"current:  {link_target(root / 'current') or '(none)'}")
    print(f"previous: {link_target(root / 'previous') or '(none)'}")
    for name in releases:
        info = json.loads((root / "releases" / name / "RELEASE.json").read_text())
        rev = (info.get("sourceRevision") or "unknown")[:12]
        print(f"  {name}  source {rev}  db schema {info['dbSchemaVersion']}")
    return 0


def cmd_preflight(args: argparse.Namespace) -> int:
    health = read_health(args.health_url)
    if health is None:
        raise Refused(
            f"cannot read the device health at {args.health_url}; check the service is "
            "running before deciding it is safe to stop"
        )
    run = health.get("run")
    outbox = health.get("outbox") or {}
    process = health.get("process") or {}
    release = process.get("release") or {}
    print(f"running: v{process.get('version')} release {release.get('version') or 'unknown'}")
    print(
        f"pending: {outbox.get('pending')}  oldest pending capturedAtMs: "
        f"{outbox.get('oldestPendingCapturedAtMs')}"
    )
    if run and run.get("state") == "active":
        raise Refused(
            f"an active run ({run.get('runId')}) is in progress; update only in a "
            "maintenance period with no active run"
        )
    print("ok: no active run. Pending events stay in the database and upload after the update.")
    return 0


# ── SQLite backup and restore (online backup API, docs/14 §8) ──────────


def table_counts(db: Path) -> dict[str, int]:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return {
            t: conn.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0]  # noqa: S608 (fixed names)
            for t in TABLES_TO_COUNT
            if t in names
        }
    finally:
        conn.close()


def check_device_db(path: Path) -> None:
    """Refuses anything that is not an intact, migrated device database."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            ok = conn.execute("PRAGMA integrity_check").fetchone()[0]
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            has_outbox = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox'"
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.DatabaseError as exc:
        raise Refused(f"{path} is not a readable SQLite database: {exc}") from None
    if ok != "ok" or version < 1 or not has_outbox:
        raise Refused(
            f"{path} is not an intact device database (integrity {ok!r}, schema {version})"
        )


def sqlite_copy(source: Path, dest: Path) -> None:
    """Consistent copy through the online backup API, WAL content included."""
    src = sqlite3.connect(source, timeout=10)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
        dst.execute("PRAGMA journal_mode=DELETE")  # a single self-contained file
    finally:
        dst.close()
        src.close()


def print_counts(label: str, db: Path) -> None:
    counts = table_counts(db)
    print(f"{label}: " + "  ".join(f"{t}: {n}" for t, n in counts.items()))


def cmd_backup(args: argparse.Namespace) -> int:
    db: Path = args.db
    if not db.exists():
        raise Refused(f"no database at {db}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    final = out / f"device-{utc_stamp()}.sqlite3"
    tmp = final.with_suffix(".partial")
    old_umask = os.umask(0o077)
    try:
        sqlite_copy(db, tmp)
    finally:
        os.umask(old_umask)
    check_device_db(tmp)
    tmp.chmod(0o600)
    tmp.rename(final)
    print(f"backup: {final}")
    print_counts("rows", final)
    return 0


def cmd_restore(args: argparse.Namespace) -> int:
    db: Path = args.db
    snapshot = Path(args.source)
    require_stopped(args.health_url)
    check_device_db(snapshot)
    if db.exists():
        keep = db.with_name(f"{db.name}.before-restore-{utc_stamp()}")
        old_umask = os.umask(0o077)
        try:
            sqlite_copy(db, keep)
        finally:
            os.umask(old_umask)
        print(f"kept the replaced state: {keep}")
        print_counts("replaced rows", keep)
    sqlite_copy(snapshot, db)
    # The service opens WAL mode again on start.
    check_device_db(db)
    print(f"restored {snapshot} -> {db}")
    print_counts("rows", db)
    print("if you ran this as root, check the file is still owned by the service user")
    return 0


# ── CLI ───────────────────────────────────────────────────────────────


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="itssb_release.py", description=__doc__.split("\n")[0])
    p.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="default /opt/itssb")
    p.add_argument("--health-url", default=DEFAULT_HEALTH, help="the device's loopback health URL")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("stage", help="copy a reviewed apps/device checkout into releases/<version>")
    s.add_argument("source")
    s.add_argument("--version", required=True)
    s.add_argument("--revision", default=None, help="git commit SHA of the source")
    s.set_defaults(func=cmd_stage)

    for name, func, help_ in (
        ("activate", cmd_activate, "point current at a staged release"),
        ("rollback", cmd_rollback, "point current back at previous"),
    ):
        a = sub.add_parser(name, help=help_)
        if name == "activate":
            a.add_argument("version")
        a.add_argument("--db", type=Path, default=DEFAULT_DB)
        a.add_argument("--accept-newer-db", action="store_true")
        a.set_defaults(func=func)

    sub.add_parser("status", help="list releases").set_defaults(func=cmd_status)
    sub.add_parser("preflight", help="refuse if a run is active").set_defaults(func=cmd_preflight)

    b = sub.add_parser("backup", help="consistent SQLite backup")
    b.add_argument("--db", type=Path, default=DEFAULT_DB)
    b.add_argument("--out", required=True)
    b.set_defaults(func=cmd_backup)

    r = sub.add_parser("restore", help="replace the database from a backup (service stopped)")
    r.add_argument("--db", type=Path, default=DEFAULT_DB)
    r.add_argument("--from", dest="source", required=True)
    r.set_defaults(func=cmd_restore)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return args.func(args)
    except Refused as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
