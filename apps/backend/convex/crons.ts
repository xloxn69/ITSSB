import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/** Bounded maintenance (docs/07 §3). */
const crons = cronJobs();

// Raw GPS retention (retention.ts). 08:00 UTC is outside school runs in the
// fictional pilot's time zone; the sweep never touches an active run anyway.
crons.daily("raw GPS retention", { hourUTC: 8, minuteUTC: 0 }, internal.retention.sweep, {});

export default crons;
