/* oxlint-disable no-console -- this CLI prints its report to the terminal. */
/**
 * `bun run eval` — tunes the baseline on earlier fictional runs and reports
 * its error on later held-out runs. Output describes the simulation only,
 * never field accuracy.
 */
import { BASELINE_V1 } from "../convex/lib/eta";
import { evaluate, preparedRoute, splitRuns, tune } from "./evaluate";
import { buildReplaySet } from "./tracks";

const RUNS = 30;
const TRAIN = 20;

const set = buildReplaySet(RUNS);
const route = preparedRoute(set);
const { train, test } = splitRuns(set, TRAIN);
const tuned = tune(route, train, "tuned-on-train");

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "—");
function report(title: string, params: typeof BASELINE_V1) {
  const r = evaluate(route, test, params);
  console.log(`\n${title}: cruise ${params.cruiseSpeedMps} m/s, dwell ${params.dwellMs / 1000} s`);
  console.log(`coverage ${(r.coverage * 100).toFixed(1)}% of upcoming-stop opportunities`);
  console.log("horizon     |      n | median |  mean |   p90 |  bias   (seconds; bias + = predicted late)");
  for (const row of [{ horizon: "all", ...r.overall }, ...r.byHorizon]) {
    console.log(
      `${row.horizon.padEnd(11)} | ${String(row.n).padStart(6)} | ${fmt(row.medianAbsS).padStart(6)} | ${fmt(row.meanAbsS).padStart(5)} | ${fmt(row.p90AbsS).padStart(5)} | ${fmt(row.biasS).padStart(5)}`,
    );
  }
}

console.log(`Fictional replay: ${RUNS} simulated runs, ${set.stops.length} stops; tuned on runs 1–${TRAIN}, reported on held-out runs ${TRAIN + 1}–${RUNS}.`);
console.log("Simulation only: these are not field measurements.");
report("Shipped baseline-v1 (held-out runs)", BASELINE_V1);
report("Best grid values on training runs (held-out runs)", tuned);
