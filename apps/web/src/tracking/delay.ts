/**
 * The driver's delay report on the Track screen (docs/10 §5, docs/08 §9.3).
 * Shown on an active run even without an arrival estimate, and never as
 * one: the category, the driver's minutes, and how long ago it was made on
 * the bus. Hidden once the server-aligned clock passes `validUntilMs`.
 */
import { reportedDelayText } from "@itssb/contracts";
import { ageClockMs, type Instant, type ServerClock } from "./clock";
import type { TrackedRun } from "./model";
import { updatedText } from "./presentation";

export function reportedDelayLine(run: TrackedRun, clock: ServerClock, now: Instant): string | null {
  const d = run.reportedDelay;
  if (!d || run.state !== "active") return null;
  const serverNow = ageClockMs(clock, now);
  if (serverNow >= d.validUntilMs) return null;
  const ago = updatedText(Math.max(0, serverNow - d.reportedAtMs)).replace(/^Updated /, "");
  return `${reportedDelayText(d)} — reported ${ago}`;
}
