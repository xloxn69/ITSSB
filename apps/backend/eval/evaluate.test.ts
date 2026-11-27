import { describe, expect, it } from "vitest";
import { BASELINE_V1 } from "../convex/lib/eta";
import { evaluate, preparedRoute, replayRun, splitRuns } from "./evaluate";
import { buildReplaySet } from "./tracks";

describe("ETA evaluation replay", () => {
  const set = buildReplaySet(4);
  const route = preparedRoute(set);

  it("replays identically from the same seed", () => {
    const again = buildReplaySet(4);
    expect(again.runs.map((r) => r.fixes.length)).toEqual(set.runs.map((r) => r.fixes.length));
    expect(again.runs[3]!.fixes.at(-1)).toEqual(set.runs[3]!.fixes.at(-1));
  });

  it("records a true arrival for every stop, in travel order", () => {
    for (const run of set.runs) {
      expect(run.trueArrivalMs).toHaveLength(set.stops.length);
      expect(run.trueArrivalMs).toEqual(run.trueArrivalMs.toSorted((a, b) => a - b));
    }
  });

  it("splits whole runs chronologically with no run in both partitions", () => {
    const { train, test } = splitRuns(set, 3);
    expect(train.map((r) => r.runIndex)).toEqual([0, 1, 2]);
    expect(test.map((r) => r.runIndex)).toEqual([3]);
  });

  it("only scores predictions made before the true arrival", () => {
    const { samples } = replayRun(route, set.runs[0]!, BASELINE_V1);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.horizonMs > 0)).toBe(true);
    const r = evaluate(route, set.runs, BASELINE_V1);
    expect(r.coverage).toBeGreaterThan(0);
    expect(r.coverage).toBeLessThanOrEqual(1);
  });
});
