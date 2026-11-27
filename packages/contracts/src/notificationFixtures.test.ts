import { describe, expect, it } from "vitest";
import myAlertsEmpty from "../fixtures/myAlerts.empty.json" with { type: "json" };
import myAlertsReady from "../fixtures/myAlerts.ready.json" with { type: "json" };
import myPreferenceDefault from "../fixtures/myPreference.default.json" with { type: "json" };
import myPreferenceReady from "../fixtures/myPreference.ready.json" with { type: "json" };
import registerDeviceRegistered from "../fixtures/registerDevice.registered.json" with { type: "json" };
import setPreferencesSaved from "../fixtures/setPreferences.saved.json" with { type: "json" };
import { notificationFixtureFiles } from "./notificationFixtures.js";

const json: Record<keyof typeof notificationFixtureFiles, unknown> = {
  "myPreference.ready": myPreferenceReady,
  "myPreference.default": myPreferenceDefault,
  "setPreferences.saved": setPreferencesSaved,
  "registerDevice.registered": registerDeviceRegistered,
  "myAlerts.ready": myAlertsReady,
  "myAlerts.empty": myAlertsEmpty,
};

describe("notification fixtures", () => {
  it.each(Object.keys(notificationFixtureFiles) as (keyof typeof notificationFixtureFiles)[])(
    "fixtures/%s.json matches the typed fixture (run `bun run fixtures` if not)",
    (name) => {
      expect(json[name]).toEqual(notificationFixtureFiles[name]);
    },
  );
});
