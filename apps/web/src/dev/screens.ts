import { FIXTURE_SCENARIOS } from "./fixtureSource";

/** Every fictional screen the screenshot script captures. */
export const FIXTURE_SCREENS: {
  name: string;
  path: string;
  ready?: string;
  /** Clicked in order after `ready` (confirm dialogs are accepted); then `after` is awaited. */
  click?: string[];
  after?: string;
}[] = [
  // Without VITE_CONVEX_URL / VITE_CLERK_PUBLISHABLE_KEY the app fails closed.
  { name: "not-configured", path: "", ready: "main h1" },
  ...FIXTURE_SCENARIOS.map((s) => ({
    name: `family-${s}`,
    path: `?fixture=${s}`,
    ready: s === "loading" ? "[aria-busy=true]" : "main h2",
  })),
  { name: "staff-routes", path: "?fixture=staff#/staff/routes", ready: "table" },
  { name: "staff-review", path: "?fixture=staff#/staff/review", ready: "table" },
  { name: "staff-draft-clean", path: "?fixture=staff#/staff/review/demo_draft_009", ready: "#decision" },
  { name: "staff-draft-warning", path: "?fixture=staff#/staff/review/demo_draft_017", ready: "#decision" },
  { name: "staff-draft-blocked", path: "?fixture=staff#/staff/review/demo_draft_021", ready: "#decision" },
  { name: "staff-draft-rejected", path: "?fixture=staff#/staff/review/demo_draft_004", ready: "main h2" },
  { name: "staff-draft-missing", path: "?fixture=staff#/staff/review/nope", ready: "main h2" },
  { name: "staff-devices", path: "?fixture=staff#/staff/devices", ready: "article" },
  {
    name: "staff-device-add",
    path: "?fixture=staff#/staff/devices",
    ready: "article",
    click: [".add-device summary"],
    after: ".add-device form",
  },
  {
    name: "staff-device-credential",
    path: "?fixture=staff#/staff/devices",
    ready: "article",
    click: ["article button:has-text('Replace credential')"],
    after: ".secret-panel",
  },
  {
    name: "staff-device-add-refused",
    path: "?fixture=staff#/staff/devices",
    ready: "article",
    click: [".add-device summary", ".add-device button[type=submit]"],
    after: ".add-device [role=status]",
  },
  { name: "staff-diagnostics", path: "?fixture=staff#/staff/diagnostics", ready: "article" },
  { name: "staff-empty-diagnostics", path: "?fixture=staff-empty#/staff/diagnostics", ready: "main section p" },
  { name: "staff-drivers", path: "?fixture=staff#/staff/drivers", ready: "main li" },
  { name: "staff-empty-routes", path: "?fixture=staff-empty#/staff/routes", ready: "main p.muted + p, main section p" },
  { name: "staff-empty-review", path: "?fixture=staff-empty#/staff/review", ready: "main section p" },
  { name: "staff-empty-devices", path: "?fixture=staff-empty#/staff/devices", ready: "main section p" },
  { name: "staff-denied", path: "?fixture=staff-denied#/staff/routes", ready: "main .message h2" },
  { name: "staff-error", path: "?fixture=staff-error#/staff/devices", ready: "main .message h2" },
  { name: "staff-loading", path: "?fixture=staff-loading#/staff/routes", ready: "[aria-busy=true]" },
];
