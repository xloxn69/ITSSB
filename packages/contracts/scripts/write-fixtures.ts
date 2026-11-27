// Writes the canonical tracking, trip-event, health, and notification fixtures to fixtures/*.json for the Swift
// tests. Run with `bun run fixtures`; src/trackingFixtures.test.ts fails if the
// JSON and the typed TypeScript values ever disagree.
import { trackingFixtureFiles } from "../src/trackingFixtures.ts";
import { checkInFixtureFiles } from "../src/checkInFixtures.ts";
import { enrollmentFixtureFiles } from "../src/enrollmentFixtures.ts";
import { healthFixtureFiles } from "../src/healthFixtures.ts";
import { notificationFixtureFiles } from "../src/notificationFixtures.ts";
import { tripEventFixtureFiles } from "../src/tripEventFixtures.ts";

const files = {
  ...trackingFixtureFiles,
  ...tripEventFixtureFiles,
  ...healthFixtureFiles,
  ...enrollmentFixtureFiles,
  ...checkInFixtureFiles,
  ...notificationFixtureFiles,
};

for (const [name, value] of Object.entries(files)) {
  await Bun.write(new URL(`../fixtures/${name}.json`, import.meta.url), `${JSON.stringify(value, null, 2)}\n`);
}
console.log(`Wrote ${Object.keys(files).length} fixtures.`);
