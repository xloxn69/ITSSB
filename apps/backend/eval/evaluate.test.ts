import { describe, expect, it } from "vitest";
import { BASELINE_V1 } from "../convex/lib/eta";
import { evaluate, preparedRoute, replayRun, type Sample, splitRuns, stopCoverage, summarize } from "./evaluate";
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

  it("reports byHorizon buckets, median, mean, p90 and bias that match a hand-computed fixture", () => {
    // Unsorted on purpose. Seconds of signed error; horizons in minutes.
    const rows: [horizonMin: number, errorS: number][] = [
      [1, 20],
      [10.5, -90],
      [0.5, -30],
      [2, 60], // exactly 2 minutes belongs to the 2–5 bucket
      [1.5, 10],
      [14, -30],
    ];
    const samples: Sample[] = rows.map(([h, e]) => ({ runIndex: 0, horizonMs: h * 60_000, errorMs: e * 1000 }));
    const r = summarize([{ samples, opportunityMs: 0, coveredMs: 0 }]);
    // |error| sorted: 10 20 30 30 60 90. p90 sits at position 4.5: 60 + 0.5 × 30.
    expect(r.overall).toEqual({ n: 6, medianAbsS: 30, meanAbsS: 40, p90AbsS: 75, biasS: -10 });
    const by = Object.fromEntries(r.byHorizon.map((b) => [b.horizon, b]));
    // 10 20 30: p90 at position 1.8 = 20 + 0.8 × 10; signed −30 + 20 + 10 = 0.
    expect(by["0–2 min"]).toEqual({ horizon: "0–2 min", n: 3, medianAbsS: 20, meanAbsS: 20, p90AbsS: 28, biasS: 0 });
    expect(by["2–5 min"]).toEqual({ horizon: "2–5 min", n: 1, medianAbsS: 60, meanAbsS: 60, p90AbsS: 60, biasS: 60 });
    expect(by["5–10 min"]!.n).toBe(0);
    expect(by["5–10 min"]!.medianAbsS).toBeNaN();
    // 30 90: p90 at position 0.9 = 30 + 0.9 × 60.
    expect(by["10–15 min"]).toEqual({ horizon: "10–15 min", n: 2, medianAbsS: 60, meanAbsS: 60, p90AbsS: 84, biasS: -60 });
    expect(by["15+ min"]!.n).toBe(0);
  });

  it("covers a stop only while a still-valid estimate from the newest fix is shown", () => {
    // Stop reached at 300 s. Estimates are valid 60 s; a newer fix replaces the older one.
    const c = stopCoverage(0, 300_000, [
      { atMs: 0, validUntilMs: 60_000 }, // replaced at 30 s: 30 s
      { atMs: 30_000, validUntilMs: 90_000 }, // replaced at 60 s: 30 s
      { atMs: 60_000, validUntilMs: null }, // withheld: the older estimate is no longer shown
      { atMs: 200_000, validUntilMs: 260_000 }, // after a dropout; replaced at 250 s: 50 s
      { atMs: 250_000, validUntilMs: 310_000 }, // ends at the arrival: 50 s
    ]);
    expect(c).toEqual({ opportunityMs: 300_000, coveredMs: 160_000 });
  });

  it("a GPS dropout counts as uncovered time, so hiding hard cases cannot raise coverage", () => {
    const run = set.runs[0]!;
    const from = run.startedAtMs + 300_000;
    const to = from + 600_000; // ten minutes with no fixes, before most stops
    const cut = { ...run, fixes: run.fixes.filter((f) => f.capturedAtMs < from || f.capturedAtMs >= to) };
    const before = evaluate(route, [run], BASELINE_V1).coverage;
    const after = evaluate(route, [cut], BASELINE_V1).coverage;
    // Per-fix coverage barely moves here (99.5% → 99.4%): it dropped the
    // missing fixes from both sides of the ratio.
    expect(before - after).toBeGreaterThan(0.2);
  });
});
