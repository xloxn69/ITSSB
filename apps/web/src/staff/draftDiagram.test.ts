import type { DraftDetail } from "@itssb/contracts";
import { describe, expect, it } from "vitest";
import { staffFixtureSource } from "../dev/staffFixtures";
import { draftDiagramLayout, STOP_PIN_RADIUS } from "./DraftDiagram";

function getDraft(draftId: string): Promise<DraftDetail> {
  const source = staffFixtureSource("staff");
  return new Promise((resolve, reject) => {
    const stop = source.watch(
      "routes:getDraft",
      { draftId },
      (raw) => {
        stop();
        resolve((raw as { draft: DraftDetail }).draft);
      },
      reject,
    );
  });
}

describe("draft diagram stop pins", () => {
  // Each numbered pin must be visible: a pin drawn over another one hides it.
  it.each(["demo_draft_009", "demo_draft_017"])("draws every stop of %s as its own visible pin", async (draftId) => {
    const draft = await getDraft(draftId);
    expect(draft.stops.length).toBeGreaterThan(1);
    const layout = draftDiagramLayout(draft.path, draft.stops)!;
    const pins = draft.stops.map((s) => layout.project(s));
    for (let a = 0; a < pins.length; a++) {
      for (let b = a + 1; b < pins.length; b++) {
        const gap = Math.hypot(pins[a]!.x - pins[b]!.x, pins[a]!.y - pins[b]!.y);
        expect(gap, `stops ${a + 1} and ${b + 1}`).toBeGreaterThanOrEqual(2 * STOP_PIN_RADIUS);
      }
    }
  });
});
