import { FIXTURE_SCENARIOS } from "./fixtureSource";

/** Every fictional screen the screenshot script captures. */
/** Optional steps run before the capture: fill inputs, check boxes, then click. */
export interface ScreenSteps {
  fill?: [selector: string, value: string][];
  check?: string[];
  click?: string;
}

export const FIXTURE_SCREENS: {
  name: string;
  path: string;
  ready?: string;
  steps?: ScreenSteps;
  /** Clicked in order after `ready` (confirm dialogs are accepted); then `after` is awaited. */
  click?: string[];
  after?: string;
}[] = [
  // Without VITE_CONVEX_URL / VITE_CLERK_PUBLISHABLE_KEY the app fails closed.
  { name: "not-configured", path: "", ready: "main h1" },
  { name: "sign-in-email", path: "?fixture=sign-in&v=email", ready: "input[name=email]" },
  { name: "sign-in-code", path: "?fixture=sign-in&v=code", ready: "input[name=code]" },
  { name: "sign-in-error", path: "?fixture=sign-in&v=error", ready: "#sign-in-problem" },
  ...FIXTURE_SCENARIOS.map((s) => ({
    name: `family-${s}`,
    path: `?fixture=${s}`,
    ready: s === "loading" ? "[aria-busy=true]" : "main h2",
  })),
  { name: "family-actions-track", path: "?fixture=family-flows", ready: "main h2" },
  { name: "family-join-code", path: "?fixture=family-flows#/join", ready: "main input" },
  { name: "family-join-form", path: "join?token=DEMX-7K2M-9QXR-4TVW-8ZPN&fixture=family-flows", ready: "form h2" },
  { name: "family-join-expired", path: "join?token=EXPX-7K2M-9QXR-4TVW-8ZPN&fixture=family-flows", ready: "main section h2 + p" },
  { name: "family-join-wrong-purpose", path: "join?token=GRDX-7K2M-9QXR-4TVW-8ZPN&fixture=family-flows", ready: "main section h2 + p" },
  {
    name: "family-join-sent",
    path: "join?token=DEMX-7K2M-9QXR-4TVW-8ZPN&fixture=family-flows",
    ready: "form h2",
    steps: { fill: [["form input >> nth=0", "Alex Fictional"], ["form input >> nth=1", "12 Fictional Lane"]], check: ["input[value=demo_stop_001]"], click: "button[type=submit]" },
    after: "text=Request sent",
  },
  {
    name: "family-join-refused",
    path: "join?token=DEMX-7K2M-9QXR-4TVW-8ZPN&fixture=family-flows",
    ready: "form h2",
    steps: { fill: [["form input >> nth=0", "Refuse Example"], ["form input >> nth=1", "12 Fictional Lane"]], check: ["input[value=none]"], click: "button[type=submit]" },
    after: "text=Not accepted",
  },
  {
    name: "family-join-unconfirmed",
    path: "join?token=DEMX-7K2M-9QXR-4TVW-8ZPN&fixture=family-flows&v=offline",
    ready: "form h2",
    steps: { fill: [["form input >> nth=0", "Alex Fictional"], ["form input >> nth=1", "12 Fictional Lane"]], check: ["input[value=demo_stop_002]"], click: "button[type=submit]" },
    after: "text=Not confirmed yet",
  },
  { name: "family-requests", path: "?fixture=family-flows#/requests", ready: "main section .badge" },
  { name: "family-requests-empty", path: "?fixture=family-flows&v=empty#/requests", ready: "main section h2" },
  { name: "family-link", path: "link?token=MMMM-NNNN-PPPP-QQQQ-RRRR&fixture=family-flows", ready: "main input" },
  {
    name: "family-link-sent",
    path: "link?token=MMMM-NNNN-PPPP-QQQQ-RRRR&fixture=family-flows",
    ready: "main input",
    steps: { fill: [["main input >> nth=1", "Jordan Guardian"]], click: "button[type=submit]" },
    after: "text=Request sent",
  },
  { name: "family-checkin", path: "?fixture=family-flows#/checkin", ready: "main section h2" },
  {
    name: "family-checkin-accepted",
    path: "checkin?token=AAAA-BBBB-CCCC-DDDD-EEEE&fixture=family-flows",
    ready: "main section input",
    steps: { click: "text=Check in >> nth=-1" },
    after: "text=your scan",
  },
  {
    name: "family-checkin-expired",
    path: "checkin?token=EXPA-BBBB-CCCC-DDDD-EEEE&fixture=family-flows",
    ready: "main section input",
    steps: { click: "text=Check in >> nth=-1" },
    after: "text=This code has expired",
  },
  { name: "family-checkin-done", path: "?fixture=family-flows&v=done#/checkin", ready: "text=your scan" },
  { name: "family-checkin-no-trip", path: "?fixture=family-flows&v=no-trip#/checkin", ready: "text=isn't running" },
  { name: "family-checkin-guardian", path: "?fixture=family-flows&v=guardian#/checkin", ready: "main section h2" },
  { name: "family-checkin-loading", path: "?fixture=family-flows&v=loading#/checkin", ready: "[aria-busy=true]" },
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
  { name: "staff-calendar", path: "?fixture=staff#/staff/calendar", ready: "article" },
  { name: "staff-empty-calendar", path: "?fixture=staff-empty#/staff/calendar", ready: "main section p" },
  {
    name: "staff-run-actions",
    path: "?fixture=staff#/staff/devices",
    ready: "article",
    click: [".run-actions summary", ".maintenance summary"],
    after: ".run-actions input",
  },
  {
    name: "staff-run-cancel-refused",
    path: "?fixture=staff#/staff/devices",
    ready: "article",
    click: [".run-actions summary", ".run-actions button:has-text('Cancel run')"],
    after: ".run-actions [role=status]",
  },
  { name: "staff-drivers", path: "?fixture=staff#/staff/drivers", ready: "main li" },
  { name: "staff-empty-routes", path: "?fixture=staff-empty#/staff/routes", ready: "main p.muted + p, main section p" },
  { name: "staff-empty-review", path: "?fixture=staff-empty#/staff/review", ready: "main section p" },
  { name: "staff-empty-devices", path: "?fixture=staff-empty#/staff/devices", ready: "main section p" },
  { name: "staff-enrollment", path: "?fixture=staff#/staff/enrollment", ready: "article" },
  { name: "staff-guardian-links", path: "?fixture=staff#/staff/guardians", ready: "article" },
  { name: "staff-invitations", path: "?fixture=staff#/staff/invitations", ready: "table" },
  { name: "staff-students", path: "?fixture=staff#/staff/students", ready: "article" },
  { name: "staff-attendance", path: "?fixture=staff#/staff/attendance", ready: "table" },
  { name: "staff-run-attendance", path: "?fixture=staff#/staff/attendance/demo_run_001", ready: "article" },
  { name: "staff-run-missing", path: "?fixture=staff#/staff/attendance/nope", ready: "main .message h2" },
  { name: "staff-audit", path: "?fixture=staff#/staff/audit", ready: "table" },
  { name: "staff-empty-enrollment", path: "?fixture=staff-empty#/staff/enrollment", ready: "main section p" },
  { name: "staff-empty-students", path: "?fixture=staff-empty#/staff/students", ready: "main section p" },
  { name: "staff-empty-attendance", path: "?fixture=staff-empty#/staff/attendance", ready: "main section p" },
  { name: "staff-denied-enrollment", path: "?fixture=staff-denied#/staff/enrollment", ready: "main .message h2" },
  { name: "staff-error-attendance", path: "?fixture=staff-error#/staff/attendance", ready: "main .message h2" },
  { name: "staff-denied", path: "?fixture=staff-denied#/staff/routes", ready: "main .message h2" },
  { name: "staff-error", path: "?fixture=staff-error#/staff/devices", ready: "main .message h2" },
  { name: "staff-loading", path: "?fixture=staff-loading#/staff/routes", ready: "[aria-busy=true]" },
];
