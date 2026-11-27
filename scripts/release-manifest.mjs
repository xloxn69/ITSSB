#!/usr/bin/env node
// Writes the release manifest (docs/14 §1): the exact source, dependency
// locks, protocol version, and every component's version, for one commit.
// Runbook: docs/runbooks/release.md.
//
// Usage: node scripts/release-manifest.mjs --environment <development|staging|production> [--out file]
//
// Refuses an uncommitted tree: a release is reproducible only from a commit.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ENVIRONMENTS = ["development", "staging", "production"];
const LOCKS = ["bun.lock", "apps/device/uv.lock"];

/** `<UTC date>-<7-char commit>`, the one name used by tags, Pi releases and notes. */
export function releaseName(nowMs, revision) {
  const d = new Date(nowMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}-${revision.slice(0, 7)}`;
}

function match(text, re, what) {
  const m = re.exec(text);
  if (!m) throw new Error(`cannot read ${what}`);
  return m[1];
}

export function buildManifest(io, { environment }) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(`environment must be one of ${ENVIRONMENTS.join(", ")}, not "${environment}"`);
  }
  if (io.dirty()) {
    throw new Error("the working tree has uncommitted changes; commit or stash them first");
  }
  const revision = io.revision();
  const nowMs = io.nowMs();
  const sha256 = (path) => createHash("sha256").update(io.read(path)).digest("hex");
  const pkg = (path) => JSON.parse(io.read(path)).version;
  const ios = io.read("apps/ios/project.yml");
  return {
    manifestVersion: 1,
    release: releaseName(nowMs, revision),
    sourceRevision: revision,
    environment,
    createdAtMs: nowMs,
    contractSchemaVersion: Number(
      match(io.read("packages/contracts/src/index.ts"), /SCHEMA_VERSION = (\d+)/, "SCHEMA_VERSION"),
    ),
    components: {
      device: {
        packageVersion: match(io.read("apps/device/src/itssb_device/__init__.py"), /__version__ = "([^"]+)"/, "device version"),
        dbSchemaVersion: io.deviceDbSchemaVersion(),
      },
      backend: { packageVersion: pkg("apps/backend/package.json") },
      web: { packageVersion: pkg("apps/web/package.json") },
      driverUi: { packageVersion: pkg("apps/driver-ui/package.json") },
      ios: {
        marketingVersion: match(ios, /MARKETING_VERSION: "([^"]+)"/, "iOS MARKETING_VERSION"),
        buildNumber: match(ios, /CURRENT_PROJECT_VERSION: "([^"]+)"/, "iOS CURRENT_PROJECT_VERSION"),
      },
    },
    locks: Object.fromEntries(LOCKS.map((p) => [p, sha256(p)])),
    toolchain: { bun: JSON.parse(io.read("package.json")).packageManager ?? null, python: ">=3.11" },
  };
}

function repoIo(root) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return {
    read: (p) => readFileSync(join(root, p), "utf8"),
    revision: () => git("rev-parse", "HEAD"),
    dirty: () => git("status", "--porcelain") !== "",
    nowMs: () => Date.now(),
    deviceDbSchemaVersion: () =>
      Number(
        execFileSync(
          "python3",
          ["-I", "-c", "import sys; sys.path.insert(0, sys.argv[1]); from itssb_device.database import MIGRATIONS; print(len(MIGRATIONS))", join(root, "apps/device/src")],
          { encoding: "utf8" },
        ).trim(),
      ),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  try {
    const manifest = buildManifest(repoIo(root), { environment: opt("--environment") ?? "" });
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    const out = opt("--out");
    if (out) writeFileSync(out, json);
    else process.stdout.write(json);
  } catch (error) {
    console.error(`release-manifest: ${error.message}`);
    process.exit(1);
  }
}
