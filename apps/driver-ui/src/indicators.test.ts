import { describe, expect, it } from "vitest";
import { cloudIndicator, environmentLabel, gpsIndicator, networkIndicator, queueIndicator, serviceIndicator, storageIndicator } from "./indicators.js";
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
});
