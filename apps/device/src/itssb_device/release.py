"""Which release is installed (docs/14 §1).

`deploy/itssb_release.py stage` writes RELEASE.json at the root of each
release (`/opt/itssb/releases/<version>/RELEASE.json`, reached through
`/opt/itssb/current`). A checkout has none, so health reports `null`: an
unidentified build, never a guessed version.
"""

from __future__ import annotations

import functools
import json
from pathlib import Path
from typing import Any

# src/itssb_device/release.py -> release root
RELEASE_FILE = Path(__file__).resolve().parent.parent.parent / "RELEASE.json"
FIELDS = ("version", "sourceRevision", "dbSchemaVersion", "filesSha256")


@functools.cache
def load_release() -> dict[str, Any] | None:
    try:
        data = json.loads(RELEASE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("version"), str):
        return None
    return {k: data.get(k) for k in FIELDS}
