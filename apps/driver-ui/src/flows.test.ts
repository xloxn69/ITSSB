import { describe, expect, it } from "vitest";
import { positionsText } from "./flows.js";

const base = { runId: "demo_run_001", endedAtMs: 0, endSync: "accepted", endError: null, endAttempts: 1 } as const;

describe("trip summary positions", () => {
  it("never says all accepted when some were rejected", () => {
    const t = positionsText({ ...base, positionsRecorded: 5, positionsWaiting: 0, positionsAccepted: 4, positionsRejected: 1 });
    expect(t).toContain("1 rejected");
    expect(t).not.toContain("all accepted");
  });

  it("names waiting positions", () => {
    const t = positionsText({ ...base, positionsRecorded: 3, positionsWaiting: 2, positionsAccepted: 1, positionsRejected: 0 });
    expect(t).toBe("3 recorded; 1 accepted by the school server; 2 waiting to sync.");
  });
});
