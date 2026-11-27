// Writes the canonical tracking fixtures to fixtures/*.json for the Swift
// tests. Run with `bun run fixtures`; src/trackingFixtures.test.ts fails if the
// JSON and the typed TypeScript values ever disagree.
import { trackingFixtureFiles } from "../src/trackingFixtures.ts";

for (const [name, value] of Object.entries(trackingFixtureFiles)) {
  await Bun.write(new URL(`../fixtures/${name}.json`, import.meta.url), `${JSON.stringify(value, null, 2)}\n`);
}
console.log(`Wrote ${Object.keys(trackingFixtureFiles).length} fixtures.`);
