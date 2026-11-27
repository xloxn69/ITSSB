#!/usr/bin/env python3
"""Row counts for a Convex snapshot export, and a comparison of two exports.

    python3 -I scripts/convex_snapshot.py counts export.zip
    python3 -I scripts/convex_snapshot.py compare before.zip after.zip

`compare` checks every table has the same document IDs and contents in both
snapshots (system fields `_creationTime` included) and exits 1 on any
difference. It prints only table names, counts and IDs, never document
contents, so the output is safe to paste into a PR for fictional dev data.
Runbook: docs/runbooks/convex-backup-restore.md. Standard library only.
"""

from __future__ import annotations

import json
import sys
import zipfile


def tables(path: str) -> dict[str, dict[str, str]]:
    """table -> {_id: canonical JSON of the document}."""
    out: dict[str, dict[str, str]] = {}
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            parts = name.split("/")
            if len(parts) != 2 or parts[1] != "documents.jsonl" or parts[0].startswith("_"):
                continue
            docs: dict[str, str] = {}
            for line in z.read(name).splitlines():
                if line.strip():
                    doc = json.loads(line)
                    docs[doc["_id"]] = json.dumps(doc, sort_keys=True)
            out[parts[0]] = docs
    return out


def counts(path: str) -> int:
    t = tables(path)
    for name in sorted(t):
        print(f"{name:20} {len(t[name]):6}")
    print(f"{'total':20} {sum(len(d) for d in t.values()):6}")
    return 0


def compare(a_path: str, b_path: str) -> int:
    a, b = tables(a_path), tables(b_path)
    problems = 0
    print(f"{'table':20} {'before':>6} {'after':>6}  result")
    for name in sorted(set(a) | set(b)):
        da, db = a.get(name, {}), b.get(name, {})
        missing = sorted(set(da) - set(db))
        extra = sorted(set(db) - set(da))
        changed = sorted(i for i in set(da) & set(db) if da[i] != db[i])
        ok = not (missing or extra or changed)
        problems += not ok
        detail = "same" if ok else f"missing {len(missing)}, extra {len(extra)}, changed {len(changed)}"
        print(f"{name:20} {len(da):6} {len(db):6}  {detail}")
    print("MATCH" if problems == 0 else f"DIFFERENT in {problems} table(s)")
    return 0 if problems == 0 else 1


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "counts":
        return counts(argv[1])
    if len(argv) == 3 and argv[0] == "compare":
        return compare(argv[1], argv[2])
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
