import { FIXTURE_SCENARIOS } from "./fixtureSource";

/** Every fictional screen the screenshot script captures. */
export const FIXTURE_SCREENS: { name: string; path: string; ready?: string }[] = [
  // Without VITE_CONVEX_URL / VITE_CLERK_PUBLISHABLE_KEY the app fails closed.
  { name: "not-configured", path: "", ready: "main h1" },
  ...FIXTURE_SCENARIOS.map((s) => ({
    name: `family-${s}`,
    path: `?fixture=${s}`,
    ready: s === "loading" ? "[aria-busy=true]" : "main h2",
  })),
];
