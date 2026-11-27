// node --test scripts/  (run in CI by the "check" job)
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildManifest, releaseName } from "./release-manifest.mjs";

const files = {
  "bun.lock": "lock-a",
  "apps/device/uv.lock": "lock-b",
  "packages/contracts/src/index.ts": "export const SCHEMA_VERSION = 1 as const;\n",
  "apps/device/src/itssb_device/__init__.py": '__version__ = "0.1.0"\n',
  "apps/ios/project.yml": '    MARKETING_VERSION: "0.2.0"\n    CURRENT_PROJECT_VERSION: "7"\n',
  "apps/web/package.json": '{"version":"0.1.0"}',
  "apps/backend/package.json": '{"version":"0.1.0"}',
  "apps/driver-ui/package.json": '{"version":"0.1.0"}',
  "package.json": '{"packageManager":"bun@1.3.0"}',
};
const io = {
  read: (p) => {
    if (!(p in files)) throw new Error(`missing ${p}`);
    return files[p];
  },
  revision: () => "abc1234def5678abc1234def5678abc1234def56",
  dirty: () => false,
  deviceDbSchemaVersion: () => 2,
  nowMs: () => Date.UTC(2026, 10, 27, 3, 0, 0),
};

test("names the release by UTC date and short commit", () => {
  assert.equal(releaseName(io.nowMs(), io.revision()), "2026.11.27-abc1234");
});

test("records source, locks, protocol and component versions", () => {
  const m = buildManifest(io, { environment: "development" });
  assert.equal(m.release, "2026.11.27-abc1234");
  assert.equal(m.sourceRevision, io.revision());
  assert.equal(m.environment, "development");
  assert.equal(m.contractSchemaVersion, 1);
  assert.equal(m.components.device.dbSchemaVersion, 2);
  assert.equal(m.components.device.packageVersion, "0.1.0");
  assert.deepEqual(m.components.ios, { marketingVersion: "0.2.0", buildNumber: "7" });
  assert.equal(m.toolchain.bun, "bun@1.3.0");
  assert.match(m.locks["bun.lock"], /^[0-9a-f]{64}$/);
  assert.notEqual(m.locks["bun.lock"], m.locks["apps/device/uv.lock"]);
});

test("refuses an uncommitted tree: a dirty build is not reproducible", () => {
  assert.throws(() => buildManifest({ ...io, dirty: () => true }, { environment: "development" }), /uncommitted/);
});

test("refuses an unknown environment", () => {
  assert.throws(() => buildManifest(io, { environment: "prod" }), /environment/);
});

test("refuses when the contract schema version cannot be read", () => {
  const broken = { ...io, read: (p) => (p.endsWith("index.ts") ? "nothing here" : io.read(p)) };
  assert.throws(() => buildManifest(broken, { environment: "development" }), /SCHEMA_VERSION/);
});
