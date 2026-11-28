import { enrollmentRequestRefused } from "@itssb/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { alertCurrency, tripNow } from "../tracking/alertDetail";
import type { TrackState } from "../tracking/store";
import type { AlertItem, TrackedRun } from "../tracking/model";
import { clearsOnEdit, commandView, enrollmentRequestArgs } from "./enrollmentModel";
import { walkingDirectionsUrl } from "./routeLinks";

describe("A07: recovery after a stop_not_eligible refusal", () => {
  const form = { requestId: "req-7", token: "ABCDEFGHJKMNPQRSTVWX", studentName: "Alex Fictional", address: "12 Fictional Lane", note: "" };

  it("editing clears the refusal, and the resend keeps the identity with the school choosing", () => {
    const refused = commandView(enrollmentRequestRefused);
    expect(refused).toMatchObject({ kind: "refused", code: "stop_not_eligible" });
    expect(clearsOnEdit(refused)).toBe(true);

    const first = enrollmentRequestArgs({ ...form, stopId: "stop_retired" });
    const resend = enrollmentRequestArgs({ ...form, stopId: "none" });
    expect(first.stopId).toBe("stop_retired");
    expect(resend.stopId).toBeNull();
    expect(resend.requestId).toBe(first.requestId);
  });

  it("an unconfirmed answer survives editing, so its resend stays unchanged", () => {
    expect(clearsOnEdit({ kind: "unconfirmed" })).toBe(false);
    expect(clearsOnEdit(null)).toBe(false);
  });

  it("a blank note is not sent", () => {
    expect(enrollmentRequestArgs({ ...form, stopId: "s1", note: "  " }).note).toBeNull();
  });
});

const alert: AlertItem = {
  alertId: "al_1",
  assignmentId: "a_1",
  runId: "run_1",
  stopLabel: "Oak & Pine",
  createdAtMs: 1_000_000,
  predictedArrivalAtMs: 1_300_000,
  predictionGeneratedAtMs: 1_000_000,
};
const run = (over: Partial<TrackedRun> = {}): TrackedRun => ({
  runId: "run_1",
  state: "active",
  liveRevision: 1,
  busLabel: "Bus 12",
  lastDeviceContactAtMs: null,
  gpsStatus: "valid",
  position: null,
  assignedStop: { stopId: "s1", label: "Oak & Pine", latitude: 34.1, longitude: -83.9, status: "unknown" },
  nextStopId: null,
  eta: { arrivalAtMs: 1_400_000, generatedAtMs: 1_000_000, validUntilMs: 1_060_000, algorithmVersion: "baseline-v1", sourceEventId: "ev_1" },
  ...over,
});

describe("alert details (I21 on the web)", () => {
  it("is never current before the live run answers", () => {
    expect(alertCurrency(alert, { kind: "checking" }).kind).toBe("checking");
    expect(alertCurrency(alert, { kind: "unknown" }).kind).toBe("unknown");
    expect(alertCurrency(alert, { kind: "run", assignmentId: "a_other", run: run() }).kind).toBe("unknown");
  });

  it("names an ended trip, a newer estimate, and the latest one", () => {
    expect(alertCurrency(alert, { kind: "no_active_run", assignmentId: "a_1" }).kind).toBe("trip_ended");
    expect(alertCurrency(alert, { kind: "run", assignmentId: "a_1", run: run({ runId: "run_2" }) }).kind).toBe("trip_ended");
    expect(alertCurrency(alert, { kind: "run", assignmentId: "a_1", run: run({ state: "completed" }) }).kind).toBe("trip_ended");
    const newer = run({ eta: { ...run().eta!, generatedAtMs: 1_030_000 } });
    expect(alertCurrency(alert, { kind: "run", assignmentId: "a_1", run: newer })).toEqual({ kind: "superseded", newerEstimateAtMs: 1_030_000 });
    expect(alertCurrency(alert, { kind: "run", assignmentId: "a_1", run: run() }).kind).toBe("latest");
    expect(alertCurrency(alert, { kind: "run", assignmentId: "a_1", run: run({ eta: null }) }).kind).toBe("running_no_estimate");
  });
});

describe("alert details while disconnected (review)", () => {
  it("never passes cached trip state into the alert's currency", () => {
    const tracking = {
      kind: "tracking",
      context: { assignment: { assignmentId: "a_1" } },
      run: run(),
    } as unknown as TrackState;
    expect(alertCurrency(alert, tripNow(tracking, false)).kind).toBe("latest");
    expect(alertCurrency(alert, tripNow(tracking, true)).kind).toBe("unconfirmed");
    const noRun = { kind: "no_active_run", context: { assignment: { assignmentId: "a_1" } } } as unknown as TrackState;
    expect(alertCurrency(alert, tripNow(noRun, true)).kind).toBe("unconfirmed");
  });
});

describe("my route and stop (I13/I14 on the web)", () => {
  it("hands walking directions to the stop's coordinates, walking only", () => {
    const url = new URL(walkingDirectionsUrl({ latitude: 34.105971, longitude: -83.977736 }));
    expect(url.hostname).toBe("www.google.com");
    expect(url.searchParams.get("destination")).toBe("34.105971,-83.977736");
    expect(url.searchParams.get("travelmode")).toBe("walking");
  });
});
