import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

<<<<<<< HEAD
/** Bounded maintenance (docs/07 §3). */
const crons = cronJobs();

// Raw GPS retention (retention.ts). 08:00 UTC is outside school runs in the
// fictional pilot's time zone; the sweep never touches an active run anyway.
crons.daily("raw GPS retention", { hourUTC: 8, minuteUTC: 0 }, internal.retention.sweep, {});
=======
const crons = cronJobs();

// Recovery for the notification outbox (docs/10 §10): reclaim expired
// leases and due retries, expire stale jobs, never resend finished ones.
crons.interval("notification outbox sweep", { minutes: 1 }, internal.notificationJobs.sweep, {});
>>>>>>> eadc32c (feat(backend): approaching alerts with a bounded-retry outbox and an APNs sender)

export default crons;
