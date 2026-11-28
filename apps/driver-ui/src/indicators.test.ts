import { describe, expect, it } from "vitest";
import { cloudIndicator, environmentLabel, gpsIndicator, networkIndicator, queueIndicator, serviceIndicator, storageIndicator } from "./indicators.js";
import { startBlockers } from "./flows.js";
import type { StorageLevel, StoragePart } from "./snapshot.js";
import { observed, snapshot } from "./testing.js";

const validFix = snapshot({
  gps: { status: "valid", gpsd: "connected", receivers: 1, lastValidFixAgeMs: 800, lastValidFixMode: 3 },
});

describe("state from health", () => {
  it("indoors: receiver present but no fix reads as No fix, not unknown or OK", () => {
    const gps = gpsIndicator(observed(snapshot()));
    expect(gps.level).toBe("problem");
    expect(gps.value).toBe("No fix");
    expect(gps.detail).toContain("No fix since the device started");
  });

  it("a valid fix is OK only while it is fresh", () => {
    expect(gpsIndicator(observed(validFix)).level).toBe("ok");
    // Same snapshot, 4 s later with no new poll: the fix has aged.
    const later = gpsIndicator(observed(validFix, 4_000));
    expect(later.level).toBe("warn");
    expect(later.detail).toBe("Last fix 4 s ago.");
  });

  it("separates receiver missing from the GPS service being down", () => {
    const missing = gpsIndicator(observed(snapshot({ gps: { status: "receiver_missing", gpsd: "connected", receivers: 0 } })));
    expect(missing.value).toBe("No receiver");
    const down = gpsIndicator(observed(snapshot({ gps: { status: "unknown", gpsd: "unreachable" } })));
    expect(down.value).toBe("GPS service down");
    expect(down.level).toBe("problem");
  });

  it("a GPS fix does not imply internet or server access", () => {
    const o = observed(validFix);
    expect(gpsIndicator(o).level).toBe("ok");
    expect(networkIndicator(o).level).not.toBe("ok");
    expect(cloudIndicator(o).level).not.toBe("ok");
  });

  it("internet does not imply an authorized server connection", () => {
    const o = observed(
      snapshot({
        network: { status: "online", lastCheckedAtMs: 1_795_607_999_000, lastOnlineAtMs: 1_795_607_999_000 },
        backend: { status: "credential_rejected", httpStatus: 401, lastOkAtMs: null },
      }),
    );
    expect(networkIndicator(o).level).toBe("ok");
    const cloud = cloudIndicator(o);
    expect(cloud.level).toBe("problem");
    expect(cloud.value).toBe("Not authorized");
  });

  it("a server that is not set up reads as off, never as offline or broken", () => {
    const o = observed(snapshot());
    expect(cloudIndicator(o).level).toBe("off");
    expect(networkIndicator(o).level).toBe("off");
  });

  it("offline shows when the internet was last seen, aged between polls", () => {
    const o = observed(
      snapshot({
        network: { status: "offline", lastCheckedAtMs: 1_795_607_999_000, lastOnlineAtMs: 1_795_607_940_000 },
        backend: { status: "unreachable", lastOkAtMs: 1_795_607_940_000 },
      }),
      5_000,
    );
    expect(networkIndicator(o).detail).toBe("No internet. Last online 65 s ago.");
    expect(cloudIndicator(o).detail).toContain("Last accepted 65 s ago");
  });

  it("pending records are a warning with the oldest age, not success", () => {
    const q = queueIndicator(
      observed(snapshot({ outbox: { pending: 12, oldestPendingCapturedAtMs: 1_795_607_880_000 } })),
    );
    expect(q.level).toBe("warn");
    expect(q.detail).toBe("12 saved on this device, waiting to sync; oldest 2 min ago.");
  });

  it("no pending records is not a claim that the server accepted anything", () => {
    const q = queueIndicator(observed(snapshot()));
    expect(q.detail).not.toContain("accepted");
  });

  it("recording is only 'Saving' during an active run", () => {
    expect(storageIndicator(observed(snapshot())).value).toBe("No run");
    const active = snapshot({ run: { runId: "demo_run_001", state: "active" } });
    expect(storageIndicator(observed(active)).value).toBe("Saving");
  });

  it("a recorder fault is shown as not saving", () => {
    const st = storageIndicator(observed(snapshot({ recorder: { fault: "disk I/O error" } })));
    expect(st.level).toBe("problem");
  });
});

describe("D12 storage and queue limits", () => {
  const MB = 1_000_000;
  const storage = (disk: StorageLevel, queue: StorageLevel, freeMb: number, pending: number): StoragePart => ({
    level: disk === "critical" || queue === "critical" ? "critical" : disk === "warning" || queue === "warning" ? "warning" : "ok",
    recording: disk === "critical" || queue === "critical" ? "reduced" : "normal",
    reducedIntervalS: 60,
    disk: { level: disk, freeBytes: freeMb * MB, totalBytes: 29_000 * MB, warnFreeBytes: 512 * MB, criticalFreeBytes: 128 * MB, error: null },
    queue: { level: queue, pending, warnPending: 10_000, criticalPending: 50_000 },
  });
  const active = { runId: "demo_run_001", state: "active" } as const;

  it("low space warns with the free space and its limit while still saving", () => {
    const st = storageIndicator(observed(snapshot({ run: active, storage: storage("warning", "ok", 410, 12) })));
    expect(st.level).toBe("warn");
    expect(st.value).toBe("Space low");
    expect(st.detail).toBe("Storage getting full: 410 MB free (limit 512 MB). Positions still save normally.");
  });

  it("a long queue warns with the count and its limit", () => {
    const st = storageIndicator(observed(snapshot({ run: active, storage: storage("ok", "warning", 4_000, 12_345) })));
    expect(st.value).toBe("Queue long");
    expect(st.detail).toBe("12345 positions waiting to sync (limit 10000). Positions still save normally.");
  });

  it("critical says recording is reduced, how often, and that nothing waiting is deleted", () => {
    const st = storageIndicator(observed(snapshot({ run: active, storage: storage("critical", "ok", 95, 184) })));
    expect(st.level).toBe("problem");
    expect(st.value).toBe("Saving less");
    expect(st.detail).toBe(
      "Storage nearly full: 95 MB free (limit 128 MB). Saving one position every 60 s until this clears; nothing waiting to sync is deleted.",
    );
  });

  it("the warning shows even with no active run", () => {
    expect(storageIndicator(observed(snapshot({ storage: storage("warning", "ok", 410, 0) }))).value).toBe("Space low");
  });

  it("a save failure still outranks a storage warning", () => {
    const st = storageIndicator(observed(snapshot({ run: active, recorder: { fault: "save failed: OperationalError" }, storage: storage("critical", "ok", 3, 0) })));
    expect(st.value).toBe("Not saving");
  });

  it("an unmeasured or healthy device makes no space claim", () => {
    const unknown = storage("unknown", "unknown", 0, 0);
    expect(storageIndicator(observed(snapshot({ run: active, storage: { ...unknown, level: "unknown" } }))).value).toBe("Saving");
    expect(storageIndicator(observed(snapshot({ run: active, storage: storage("ok", "ok", 4_000, 0) }))).value).toBe("Saving");
  });

  it("reduced recording does not block starting a run; a save failure does", () => {
    const caps = { recordRoute: { available: true }, startRoute: { available: true }, showQr: { available: true }, showStudents: { available: true } };
    const critical = observed(snapshot({ capabilities: caps, storage: storage("critical", "critical", 95, 60_000) }));
    expect(startBlockers(critical, "demo_route_version_003")).toEqual([]);
    const failing = observed(snapshot({ capabilities: caps, recorder: { fault: "save failed: OperationalError" } }));
    expect(startBlockers(failing, "demo_route_version_003")).toEqual(["This device is not saving positions."]);
  });
});

describe("when the device service stops answering", () => {
  it("before the first answer, everything is unknown", () => {
    const o = observed(null);
    expect(serviceIndicator(o).level).toBe("unknown");
    expect(gpsIndicator(o).level).toBe("unknown");
  });

  it("a failed poll hides the last good reading instead of showing it as current", () => {
    const o = observed(validFix, 1_000, true);
    expect(serviceIndicator(o).level).toBe("problem");
    for (const ind of [gpsIndicator(o), networkIndicator(o), cloudIndicator(o), queueIndicator(o)]) {
      expect(ind.level).toBe("unknown");
    }
  });

  it("a snapshot that stopped arriving goes unknown even without a failed poll", () => {
    const o = observed(validFix, 7_000);
    expect(serviceIndicator(o).detail).toBe("The device service last answered 7 s ago. Nothing below is current.");
    expect(gpsIndicator(o).level).toBe("unknown");
  });
});

const labelFor = (environment: string) =>
  environmentLabel(observed(snapshot({ process: { version: "0.1.0", bootId: "b", uptimeS: 1, environment } })));

describe("environmentLabel (docs/14 §2)", () => {
  it("labels a development or staging device and nothing in production", () => {
    const at = labelFor;
    expect(at("development")).toBe("Development device");
    expect(at("staging")).toBe("Staging device");
    expect(at("production")).toBeNull();
  });

  it("says nothing it can't know: an older device without the field, or no answer", () => {
    expect(environmentLabel(observed(snapshot()))).toBeNull();
    expect(environmentLabel({ ...observed(snapshot()), snapshot: null })).toBeNull();
  });

  it("drops the label once the device stops answering, instead of showing a cached one", () => {
    const dev = snapshot({ process: { version: "0.1.0", bootId: "b", uptimeS: 1, environment: "development" } });
    expect(environmentLabel({ ...observed(dev), pollFailed: true })).toBeNull();
    expect(environmentLabel(observed(dev, 60_000))).toBeNull();
  });
});
