import type {
  DeviceSummary,
  DriverGrantSummary,
  DriverSummary,
  GrantableRouteVersion,
  ListDriverGrantsResult,
  DiagnosticsResult,
  ListMaintenanceResult,
  ListServiceDaysResult,
  DraftDetail,
  GetDraftResult,
  ListDevicesResult,
  ListDraftsResult,
  ListDriversResult,
  ListRoutesResult,
} from "@itssb/contracts";
import { useEffect, useState } from "react";
import { DraftDiagram } from "./DraftDiagram";
import { AttendancePage, AuditPage, EnrollmentPage, GuardianLinksPage, InvitationsPage, RunAttendancePage, StudentsPage } from "./EnrollmentPages";
import {
  approvalBlocker,
  contactStatus,
  DIRECTION_LABEL,
  dateTime,
  deviceMetricFacts,
  driversFileEntry,
  maintenanceWindow,
  notificationJobFacts,
  runActionsAvailable,
  serviceDateLabel,
  sweepSummary,
} from "./format";
import {
  type CredentialOutcome,
  credentialOutcome,
  type GrantOutcome,
  grantOutcome,
  type StaffActionName,
  type StaffSource,
} from "./source";
import { StaffTeamPage } from "./StaffTeamPage";
import { Empty, Loaded, Outcome, type Ready, useMutation, useNow, useStaffQuery } from "./ui";

/** Staff console (docs/12 §3–4). The server checks the staff role on every call. */
export function StaffApp({ source }: { source: StaffSource }) {
  const route = useHashRoute();
  const parts = route.split("/").filter(Boolean); // ["staff", page, id?]
  const page = parts[1] ?? "routes";
  const tabs: [string, string][] = [
    ["routes", "Routes"],
    ["review", "Route review"],
    ["devices", "Buses & devices"],
    ["calendar", "Service calendar"],
    ["drivers", "Drivers"],
    ["team", "Staff"],
    ["diagnostics", "Diagnostics"],
    ["enrollment", "Enrollment"],
    ["guardians", "Guardian links"],
    ["invitations", "Invitations"],
    ["students", "Students"],
    ["attendance", "Attendance"],
    ["audit", "Audit"],
  ];
  return (
    <div className="stack">
      <nav className="switcher" aria-label="Staff sections">
        {tabs.map(([key, label]) => (
          <a key={key} className="chip" href={`#/staff/${key}`} aria-current={page === key ? "page" : undefined}>
            {label}
          </a>
        ))}
      </nav>
      {page === "routes" && <RoutesPage source={source} />}
      {page === "review" && !parts[2] && <ReviewQueuePage source={source} />}
      {page === "review" && parts[2] && <DraftPage source={source} draftId={parts[2]} />}
      {page === "devices" && <DevicesPage source={source} />}
      {page === "calendar" && <CalendarPage source={source} />}
      {page === "drivers" && <DriversPage source={source} />}
      {page === "team" && <StaffTeamPage source={source} />}
      {page === "diagnostics" && <DiagnosticsPage source={source} />}
      {page === "enrollment" && <EnrollmentPage source={source} />}
      {page === "guardians" && <GuardianLinksPage source={source} />}
      {page === "invitations" && <InvitationsPage source={source} />}
      {page === "students" && <StudentsPage source={source} />}
      {page === "attendance" && !parts[2] && <AttendancePage source={source} />}
      {page === "attendance" && parts[2] && <RunAttendancePage source={source} runId={parts[2]} />}
      {page === "audit" && <AuditPage source={source} />}
    </div>
  );
}

function useHashRoute(): string {
  const [hash, setHash] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const onChange = () => setHash(location.hash.slice(1));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

// MARK: Routes

function RoutesPage({ source }: { source: StaffSource }) {
  const { state } = useStaffQuery<Ready<ListRoutesResult>>(source, "routes:list");
  return (
    <section className="card stack">
      <h1>Routes</h1>
      <p className="muted small">The approved version is the one a new run uses. Approved versions never change.</p>
      <Loaded state={state}>
        {({ routes }) =>
          routes.length === 0 ? (
            <Empty text="No approved routes yet. Approve a recorded draft in Route review." />
          ) : (
            <table className="responsive-table">
              <thead>
                <tr>
                  <th>Route</th>
                  <th>Direction</th>
                  <th>Approved version</th>
                  <th>Approved</th>
                  <th>Stops</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((r) => (
                  <tr key={r.routeId}>
                    <td data-label="Route">{r.label}</td>
                    <td data-label="Direction">{DIRECTION_LABEL[r.direction]}</td>
                    <td data-label="Approved version">
                      {r.currentVersion ? `v${r.currentVersion.versionNumber ?? "?"}` : "None yet"}
                    </td>
                    <td data-label="Approved">
                      {r.currentVersion
                        ? `${dateTime(r.currentVersion.approvedAtMs)}${r.currentVersion.approvedByName ? ` by ${r.currentVersion.approvedByName}` : ""}`
                        : "—"}
                    </td>
                    <td data-label="Stops">{r.currentVersion?.stopCount ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Loaded>
    </section>
  );
}

// MARK: Review

const STATUS_LABEL = { submitted: "Waiting for review", approved: "Approved", rejected: "Rejected" } as const;

function ReviewQueuePage({ source }: { source: StaffSource }) {
  const { state } = useStaffQuery<Ready<ListDraftsResult>>(source, "routes:listDrafts");
  return (
    <section className="card stack">
      <h1>Route review</h1>
      <p className="muted small">Drivers record routes on the bus. Each draft stays private until you approve it.</p>
      <Loaded state={state}>
        {({ drafts }) =>
          drafts.length === 0 ? (
            <Empty text="No recorded drafts. They appear here when a driver submits one." />
          ) : (
            <table className="responsive-table">
              <thead>
                <tr>
                  <th>Draft</th>
                  <th>Status</th>
                  <th>Kind</th>
                  <th>Submitted</th>
                  <th>Stops</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => (
                  <tr key={d.draftId}>
                    <td data-label="Draft">
                      <a href={`#/staff/review/${encodeURIComponent(d.draftId)}`}>{d.label}</a>
                      <div className="muted small">{DIRECTION_LABEL[d.direction]}</div>
                    </td>
                    <td data-label="Status">
                      <span className="badge">{STATUS_LABEL[d.status]}</span>
                      {d.decisionReason && <div className="muted small">{d.decisionReason}</div>}
                    </td>
                    <td data-label="Kind">{d.routeId ? "Revision" : "New route"}</td>
                    <td data-label="Submitted">{dateTime(d.submittedAtMs)}</td>
                    <td data-label="Stops">{d.stopCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Loaded>
    </section>
  );
}

function DraftPage({ source, draftId }: { source: StaffSource; draftId: string }) {
  const { state } = useStaffQuery<Ready<GetDraftResult>>(source, "routes:getDraft", { draftId });
  return (
    <div className="stack">
      <a href="#/staff/review" className="small">
        ← Route review
      </a>
      <Loaded state={state}>{({ draft }) => <DraftReview source={source} draft={draft} />}</Loaded>
    </div>
  );
}

function DraftReview({ source, draft }: { source: StaffSource; draft: DraftDetail }) {
  const { busy, outcome, run } = useMutation(source);
  const [reason, setReason] = useState("");
  const blocker = approvalBlocker(draft);
  const approve = () => {
    const message = `Approve "${draft.label}"? It becomes the version new runs use. Runs already under way keep their version.`;
    if (window.confirm(message)) void run("routes:approveDraft", { draftId: draft.draftId }, "Approved. New runs now use this version.");
  };
  const reject = () => void run("routes:rejectDraft", { draftId: draft.draftId, reason }, "Rejected. The reason is saved.");
  return (
    <>
      <header className="stack" style={{ gap: "var(--space-xs)" }}>
        <h1>{draft.label}</h1>
        <p className="muted">
          {DIRECTION_LABEL[draft.direction]} · {draft.routeId ? "Revision of an approved route" : "New route"} ·{" "}
          {STATUS_LABEL[draft.status]}
        </p>
      </header>
      <div className="track-grid">
        <section className="card">
          <DraftDiagram path={draft.path} stops={draft.stops} label={draft.label} gapBeforeIndexes={draft.gapBeforeIndexes ?? []} />
          {(draft.gapBeforeIndexes?.length ?? 0) > 0 && (
            <p className="muted small">Dashed: GPS was lost while recording. That stretch is not measured travel.</p>
          )}
        </section>
        <div className="stack">
          <section className="card stack" aria-labelledby="checks">
            <h2 id="checks">Checks</h2>
            {draft.checks.length === 0 ? (
              <p className="muted">No problems found in the recording.</p>
            ) : (
              <ul className="stack" style={{ margin: 0, paddingLeft: 0, listStyle: "none", gap: "var(--space-sm)" }}>
                {draft.checks.map((c) => (
                  <li key={`${c.code}-${c.message}`} className="status">
                    <span className={`dot tone-${c.severity === "blocking" ? "stale" : "aging"}`} aria-hidden />
                    <span>
                      <strong>{c.severity === "blocking" ? "Must fix: " : "Check: "}</strong>
                      {c.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">
              {draft.pointCount} recorded points · submitted {dateTime(draft.submittedAtMs)}
            </p>
          </section>
          <section className="card stack" aria-labelledby="stops">
            <h2 id="stops">Stops in order</h2>
            {draft.stops.length === 0 ? (
              <p className="muted">No stops were marked.</p>
            ) : (
              <ol style={{ margin: 0, paddingLeft: "var(--space-xl)" }}>
                {draft.stops.map((s) => (
                  <li key={s.sequence}>
                    {s.label}
                    {s.instructions && <div className="muted small">{s.instructions}</div>}
                  </li>
                ))}
              </ol>
            )}
          </section>
          {draft.status === "submitted" ? (
            <section className="card stack" aria-labelledby="decision">
              <h2 id="decision">Decision</h2>
              <button type="button" className="btn btn-primary" disabled={busy || blocker !== null} onClick={approve}>
                Approve this route
              </button>
              {blocker && <p className="muted small">{blocker}</p>}
              <label>
                Reason for rejecting
                <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              </label>
              <button type="button" className="btn" disabled={busy || !reason.trim()} onClick={reject}>
                Reject with this reason
              </button>
              <Outcome outcome={outcome} />
            </section>
          ) : (
            <section className="card stack">
              <h2>Decision</h2>
              <p>
                {STATUS_LABEL[draft.status]}
                {draft.reviewerName && ` by ${draft.reviewerName}`} · {dateTime(draft.reviewedAtMs)}
              </p>
              {draft.decisionReason && <p className="muted">{draft.decisionReason}</p>}
              <Outcome outcome={outcome} />
            </section>
          )}
        </div>
      </div>
    </>
  );
}

/** Runs a credential action; the issued secret lives only in this component's state. */
function useCredentialAction(source: StaffSource) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CredentialOutcome | null>(null);
  async function run(name: StaffActionName, args: Record<string, string>) {
    setBusy(true);
    setResult(null);
    try {
      setResult(credentialOutcome(await source.act(name, args)));
    } catch {
      setResult({ kind: "failed", message: "No answer from the server. Reload to see whether a credential was issued." });
    } finally {
      setBusy(false);
    }
  }
  return { busy, result, run, clear: () => setResult(null) };
}

/**
 * The one time a device secret is visible. It is not stored anywhere in the
 * browser; dismissing the panel discards it.
 */
function SecretPanel({ label, secret, onDone }: { label: string; secret: string; onDone: () => void }) {
  return (
    <div className="card stack secret-panel" role="alert" style={{ gap: "var(--space-sm)" }}>
      <h3>New credential for {label}</h3>
      <p className="small">
        Shown once. Put it in the Pi&apos;s <code>/etc/itssb/device.env</code> as <code>ITSSB_DEVICE_TOKEN</code>, then
        restart the device service. Don&apos;t paste it into chat, email, or a screenshot.
      </p>
      <input className="secret" readOnly value={secret} aria-label="Device credential" onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="btn" onClick={onDone} style={{ alignSelf: "flex-start" }}>
        I&apos;ve installed it, hide it
      </button>
    </div>
  );
}

function CredentialResult({ result, label, onDone }: { result: CredentialOutcome | null; label: string; onDone: () => void }) {
  if (!result) return null;
  if (result.kind === "issued") return <SecretPanel label={label} secret={result.deviceSecret} onDone={onDone} />;
  return <Outcome outcome={result} />;
}

function AddDevice({ source }: { source: StaffSource }) {
  const [label, setLabel] = useState("");
  const [busLabel, setBusLabel] = useState("");
  const [issuedFor, setIssuedFor] = useState("");
  const { busy, result, run, clear } = useCredentialAction(source);
  return (
    <details className="card stack add-device" style={{ gap: "var(--space-sm)" }}>
      <summary>
        <strong>Add a device</strong>
      </summary>
      <p className="muted small">Each Pi gets its own credential. Never copy one SD card image to two buses.</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setIssuedFor(label.trim());
          void run("fleet:provisionDevice", { label, busLabel });
        }}
      >
        <label style={{ flex: "1 1 12rem" }}>
          Device name
          <input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="Pi in Bus 9" />
        </label>
        <label style={{ flex: "1 1 8rem" }}>
          Bus name families see (optional)
          <input value={busLabel} maxLength={40} onChange={(e) => setBusLabel(e.target.value)} placeholder="Bus 9" />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy} style={{ alignSelf: "flex-end" }}>
          Add device
        </button>
      </form>
      <CredentialResult
        result={result}
        label={issuedFor}
        onDone={() => {
          clear();
          setLabel("");
          setBusLabel("");
        }}
      />
    </details>
  );
}

// MARK: Devices

function DevicesPage({ source }: { source: StaffSource }) {
  const { state, receivedAtWallMs } = useStaffQuery<Ready<ListDevicesResult>>(source, "fleet:listDevices");
  return (
    <section className="card stack">
      <h1>Buses &amp; devices</h1>
      <p className="muted small">A device that stops reporting is shown as not reporting, never as a moving bus.</p>
      {state.kind === "ready" && <AddDevice source={source} />}
      <Loaded state={state}>
        {({ devices, serverNowMs }) =>
          devices.length === 0 ? (
            <Empty text="No devices are enrolled yet." />
          ) : (
            <div className="stack">
              <MaintenanceSection source={source} devices={devices} />
              {devices.map((d) => (
                <DeviceRow
                  key={d.deviceId}
                  source={source}
                  device={d}
                  spares={devices.filter((x) => !x.revoked && !x.activeRun && x.deviceId !== d.deviceId)}
                  serverNowMs={serverNowMs}
                  receivedAtWallMs={receivedAtWallMs}
                />
              ))}
            </div>
          )
        }
      </Loaded>
    </section>
  );
}

function DeviceRow({
  source,
  device,
  spares,
  serverNowMs,
  receivedAtWallMs,
}: {
  source: StaffSource;
  device: DeviceSummary;
  spares: DeviceSummary[];
  serverNowMs: number;
  receivedAtWallMs: number;
}) {
  const now = useNow();
  const contact = contactStatus(device.lastContactAtMs, serverNowMs, receivedAtWallMs, now, device.revoked);
  const [label, setLabel] = useState(device.busLabel ?? "");
  const { busy, outcome, run } = useMutation(source);
  const credential = useCredentialAction(source);
  const revoke = () => {
    if (
      window.confirm(
        `Revoke "${device.label}"? Its reports are rejected from now on. A revoked device can't be restored: provision a new one.`,
      )
    ) {
      void run("fleet:revokeDevice", { deviceId: device.deviceId }, "Revoked.");
    }
  };
  const rotate = () => {
    if (
      window.confirm(
        `Replace the credential for "${device.label}"? The current one stops working now. The Pi keeps recording and its uploads wait until you install the new credential.`,
      )
    ) {
      void credential.run("fleet:rotateDeviceCredential", { deviceId: device.deviceId });
    }
  };
  return (
    <article className="card stack" style={{ gap: "var(--space-sm)" }}>
      <div className="row spread">
        <h2>
          {device.label}
          {device.busLabel && <span className="muted"> · {device.busLabel}</span>}
        </h2>
        {device.revoked && <span className="badge">Revoked</span>}
      </div>
      <p className="status">
        <span className={`dot tone-${contact.tone}`} aria-hidden />
        <span>{contact.text}</span>
      </p>
      <p className="muted small">
        {device.activeRun
          ? `Active run: ${device.activeRun.routeLabel ?? "unknown route"}, started ${dateTime(device.activeRun.startedAtMs)}`
          : "No active run"}
      </p>
      {device.activeRun && runActionsAvailable(device) && (
        <RunActions source={source} runId={device.activeRun.runId} spares={spares} />
      )}
      {!device.revoked && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run("fleet:setBusLabel", { deviceId: device.deviceId, busLabel: label }, "Bus name saved.");
          }}
        >
          <label style={{ flex: "1 1 12rem" }}>
            Bus name families see
            <input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder="Bus 12" />
          </label>
          <button type="submit" className="btn" disabled={busy} style={{ alignSelf: "flex-end" }}>
            Save name
          </button>
          <button type="button" className="btn" disabled={busy || credential.busy} onClick={rotate} style={{ alignSelf: "flex-end" }}>
            Replace credential
          </button>
          <button type="button" className="btn" disabled={busy} onClick={revoke} style={{ alignSelf: "flex-end" }}>
            Revoke device
          </button>
        </form>
      )}
      <Outcome outcome={outcome} />
      <CredentialResult result={credential.result} label={device.label} onDone={credential.clear} />
    </article>
  );
}

// MARK: Drivers (docs/12 §3)

const GRANT_HOURS = ["4", "8", "12", "16"] as const;

function DriversPage({ source }: { source: StaffSource }) {
  const { state } = useStaffQuery<Ready<ListDriversResult>>(source, "fleet:listDrivers");
  const grants = useStaffQuery<Ready<ListDriverGrantsResult>>(source, "driverGrants:listForStaff");
  const devices = useStaffQuery<Ready<ListDevicesResult>>(source, "fleet:listDevices");
  return (
    <section className="card stack">
      <h1>Drivers</h1>
      <p className="muted small">
        Drivers unlock the bus screen with a PIN. Driving permission comes from a driver grant: one driver, one bus, chosen
        routes, for one school day at most.
      </p>
      {state.kind === "ready" && <AddDriver source={source} />}
      <Loaded state={state}>
        {({ drivers }) =>
          drivers.length === 0 ? (
            <Empty text="No drivers yet. Add one above." />
          ) : (
            <Loaded state={grants.state}>
              {(g) => (
                <div className="stack">
                  {drivers.map((d) => (
                    <DriverRow
                      key={d.userId}
                      source={source}
                      driver={d}
                      grants={g.grants.filter((x) => x.driverUserId === d.userId)}
                      routeVersions={g.routeVersions}
                      devices={devices.state.kind === "ready" ? devices.state.value.devices.filter((x) => !x.revoked) : []}
                    />
                  ))}
                </div>
              )}
            </Loaded>
          )
        }
      </Loaded>
    </section>
  );
}

function AddDriver({ source }: { source: StaffSource }) {
  const [name, setName] = useState("");
  const { busy, outcome, run } = useMutation(source);
  return (
    <details className="card stack add-driver" style={{ gap: "var(--space-sm)" }}>
      <summary>
        <strong>Add a driver</strong>
      </summary>
      <p className="muted small">Drivers don&apos;t need an app account. Set their PIN on the bus when you install a grant.</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run("fleet:addDriver", { displayName: name }, "Driver added. Issue a grant to let them drive.");
        }}
      >
        <label style={{ flex: "1 1 12rem" }}>
          Name
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Dana Driver" />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy} style={{ alignSelf: "flex-end" }}>
          Add driver
        </button>
      </form>
      <Outcome outcome={outcome} />
    </details>
  );
}

function DriverRow({
  source,
  driver,
  grants,
  routeVersions,
  devices,
}: {
  source: StaffSource;
  driver: DriverSummary;
  grants: DriverGrantSummary[];
  routeVersions: GrantableRouteVersion[];
  devices: DeviceSummary[];
}) {
  const revoke = useMutation(source);
  return (
    <article className="card stack driver" style={{ gap: "var(--space-sm)" }}>
      <h2>{driver.displayName}</h2>
      {grants.length === 0 ? (
        <p className="muted small">No active grant: this driver can&apos;t start a run.</p>
      ) : (
        <ul className="stack" style={{ gap: "var(--space-sm)", margin: 0, paddingLeft: "var(--space-lg)" }}>
          {grants.map((g) => (
            <li key={g.grantId}>
              <strong>{g.deviceLabel}</strong>: {g.routeVersions.map((r) => r.label).join(", ")}
              <span className="muted small">
                {" "}
                · until {dateTime(g.expiresAtMs)}
                {g.issuedByName ? ` · issued by ${g.issuedByName}` : ""}
              </span>{" "}
              <button
                type="button"
                className="btn"
                disabled={revoke.busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Revoke ${driver.displayName}'s grant on ${g.deviceLabel}? It stops working now. A run it started can't be ended from the bus after this: cancel that run under Buses & devices.`,
                    )
                  ) {
                    void revoke.run("driverGrants:revokeForStaff", { grantId: g.grantId }, "Grant revoked.");
                  }
                }}
              >
                Revoke grant
              </button>
            </li>
          ))}
        </ul>
      )}
      <Outcome outcome={revoke.outcome} />
      <IssueGrant source={source} driver={driver} routeVersions={routeVersions} devices={devices} />
    </article>
  );
}

function IssueGrant({
  source,
  driver,
  routeVersions,
  devices,
}: {
  source: StaffSource;
  driver: DriverSummary;
  routeVersions: GrantableRouteVersion[];
  devices: DeviceSummary[];
}) {
  const [deviceId, setDeviceId] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [hours, setHours] = useState<string>("12");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GrantOutcome | null>(null);
  async function issue() {
    setBusy(true);
    setResult(null);
    try {
      setResult(
        grantOutcome(
          await source.act("driverGrants:issueForDriver", {
            driverUserId: driver.userId,
            deviceId,
            routeVersionIds: chosen,
            ttlMs: Number(hours) * 60 * 60 * 1000,
          }),
        ),
      );
    } catch {
      setResult({ kind: "failed", message: "No answer from the server. Reload to see whether a grant was issued." });
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="issue-grant">
      <summary>Issue a grant</summary>
      <form
        className="stack"
        style={{ gap: "var(--space-sm)", paddingTop: "var(--space-sm)" }}
        onSubmit={(e) => {
          e.preventDefault();
          void issue();
        }}
      >
        <div className="row">
          <label style={{ flex: "1 1 10rem" }}>
            Bus device
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">Choose a device</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                  {d.busLabel ? ` (${d.busLabel})` : ""}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: "0 1 8rem" }}>
            Valid for
            <select value={hours} onChange={(e) => setHours(e.target.value)}>
              {GRANT_HOURS.map((h) => (
                <option key={h} value={h}>
                  {h} hours
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="stack flush" style={{ border: "none", padding: 0, gap: "var(--space-xs)" }}>
          <legend>Routes this driver may run</legend>
          {routeVersions.length === 0 ? (
            <p className="muted small">No approved routes yet. Approve one in Route review.</p>
          ) : (
            routeVersions.map((r) => (
              <label key={r.routeVersionId} className="choice">
                <input
                  type="checkbox"
                  checked={chosen.includes(r.routeVersionId)}
                  onChange={(e) =>
                    setChosen((c) => (e.target.checked ? [...c, r.routeVersionId] : c.filter((x) => x !== r.routeVersionId)))
                  }
                />
                <span>
                  {r.label}
                  {r.versionNumber !== null && <span className="muted small"> v{r.versionNumber}</span>}
                </span>
              </label>
            ))
          )}
        </fieldset>
        <button type="submit" className="btn btn-primary" disabled={busy || !deviceId || chosen.length === 0} style={{ alignSelf: "flex-start" }}>
          Issue grant
        </button>
      </form>
      {result?.kind === "issued" ? (
        <GrantPanel issued={result} onDone={() => setResult(null)} />
      ) : (
        <Outcome outcome={result} />
      )}
    </details>
  );
}

/**
 * The one time a grant is visible. It is not stored anywhere in the browser;
 * dismissing the panel discards it.
 */
function GrantPanel({ issued, onDone }: { issued: Extract<GrantOutcome, { kind: "issued" }>; onDone: () => void }) {
  return (
    <div className="card stack secret-panel" role="alert" style={{ gap: "var(--space-sm)" }}>
      <h3>New grant for {issued.driverName}</h3>
      <p className="small">
        Shown once. Valid until {dateTime(issued.expiresAtMs)}. On the Pi, make the PIN hash with <code>hash-pin</code>,
        then put this entry inside <code>{'{"drivers": [ ... ]}'}</code> in <code>/etc/itssb/drivers.json</code>, replacing
        any older entry for this driver, and restart the device service. Don&apos;t paste it into chat, email, or a
        screenshot.
      </p>
      <textarea
        className="secret"
        readOnly
        rows={9}
        value={driversFileEntry(issued)}
        aria-label="Drivers file entry"
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="button" className="btn" onClick={onDone} style={{ alignSelf: "flex-start" }}>
        I&apos;ve installed it, hide it
      </button>
    </div>
  );
}

// MARK: Diagnostics

const RUN_STATE_LABEL = { scheduled: "Scheduled", active: "Active", completed: "Completed", cancelled: "Cancelled" } as const;

/** Limited support view (docs/12 §11): IDs, ages and versions only. */
function DiagnosticsPage({ source }: { source: StaffSource }) {
  const { state, receivedAtWallMs } = useStaffQuery<Ready<DiagnosticsResult>>(source, "fleet:diagnostics");
  const now = useNow();
  return (
    <section className="card stack">
      <h1>Diagnostics</h1>
      <p className="muted small">
        Run IDs, contact ages, versions and device measurements for support. No positions, addresses or credentials are shown here.
      </p>
      <Loaded state={state}>
        {({ deployment, retention, devices, notifications, serverNowMs }) => (
          <div className="stack">
            <dl className="facts">
              <dt>Backend release</dt>
              <dd>{deployment.release ?? "Not recorded on this deployment"}</dd>
              <dt>Environment</dt>
              <dd>{deployment.environment ?? "Not recorded"}</dd>
              <dt>Contract version</dt>
              <dd>{deployment.contractSchemaVersion}</dd>
              <dt>Raw GPS kept</dt>
              <dd>{retention.rawGpsDays} days after a run ends</dd>
              <dt>Last cleanup</dt>
              <dd>
                {retention.lastSweepAtMs === null
                  ? "Nothing deleted yet"
                  : `${dateTime(retention.lastSweepAtMs)}: ${sweepSummary(retention.lastSweepDeleted) ?? "details unreadable"}`}
              </dd>
            </dl>
            <h2>Notifications</h2>
            <dl className="facts">
              {notificationJobFacts(notifications, serverNowMs, receivedAtWallMs, now).flatMap(([k, v]) => [
                <dt key={`${k}-k`}>{k}</dt>,
                <dd key={`${k}-v`}>{v}</dd>,
              ])}
            </dl>
            {devices.length === 0 ? (
              <Empty text="No devices are enrolled yet." />
            ) : (
              <div className="stack" style={{ gap: "var(--space-md)" }}>
                {devices.map((d) => {
                  const contact = contactStatus(d.lastContactAtMs, serverNowMs, receivedAtWallMs, now, d.revoked);
                  return (
                    <article key={d.deviceId} className="card stack" style={{ gap: "var(--space-sm)" }}>
                      <h2>
                        {d.label}
                        {d.busLabel && <span className="muted"> · {d.busLabel}</span>}
                      </h2>
                      <p className="status">
                        <span className={`dot tone-${contact.tone}`} aria-hidden />
                        <span>{contact.text}</span>
                      </p>
                      <dl className="facts small">
                        <dt>Device ID</dt>
                        <dd className="mono">{d.deviceId}</dd>
                        <dt>Software</dt>
                        <dd>{d.softwareVersion ? `v${d.softwareVersion}` : "Not reported"}</dd>
                        <dt>Waiting to upload</dt>
                        <dd>
                          {d.pendingCount === null
                            ? "Not reported"
                            : d.pendingCount === 0
                              ? "Nothing"
                              : `${d.pendingCount}, oldest captured ${dateTime(d.oldestPendingCapturedAtMs)}`}
                        </dd>
                        <dt>Active run</dt>
                        <dd className="mono">{d.activeRunId ?? "None"}</dd>
                        <dt>Most recent run</dt>
                        <dd>
                          {d.lastRun ? (
                            <>
                              {RUN_STATE_LABEL[d.lastRun.state]}
                              {d.lastRun.endedAtMs !== null && `, ended ${dateTime(d.lastRun.endedAtMs)}`}
                              <div className="muted mono">{d.lastRun.runId}</div>
                            </>
                          ) : (
                            "No runs"
                          )}
                        </dd>
                        {deviceMetricFacts(d.metrics, serverNowMs, receivedAtWallMs, now, d.softwareVersion !== null).flatMap(([k, v]) => [
                          <dt key={`${k}-k`}>{k}</dt>,
                          <dd key={`${k}-v`}>{v}</dd>,
                        ])}
                      </dl>
                    </article>
                  );
                })}
              </div>
            )}
            <p className="muted small">
              Software, upload queue and measurements come from each device&apos;s latest heartbeat; read them with
              their age. Upload retries count since the device software last started.
            </p>
          </div>
        )}
      </Loaded>
    </section>
  );
}

// MARK: Run actions (docs/12 §7)

function RunActions({ source, runId, spares }: { source: StaffSource; runId: string; spares: DeviceSummary[] }) {
  const [reason, setReason] = useState("");
  const [spare, setSpare] = useState("");
  const { busy, outcome, run } = useMutation(source);
  const cancel = () => {
    if (window.confirm("Cancel this run? The bus's positions stop being accepted, and families' apps show no trip running.")) {
      void run("runOps:cancelRun", { runId, reason }, "Run cancelled.");
    }
  };
  const replace = () => {
    const label = spares.find((d) => d.deviceId === spare)?.label ?? "the chosen bus";
    if (window.confirm(`Cancel this run and send ${label}? Its driver then starts the same route as usual.`)) {
      void run("runOps:replaceDevice", { runId, replacementDeviceId: spare, reason }, `Run cancelled; ${label} can start the route.`);
    }
  };
  return (
    <details className="run-actions">
      <summary>Cancel or replace this run</summary>
      <div className="stack" style={{ gap: "var(--space-sm)", paddingTop: "var(--space-sm)" }}>
        <label>
          Reason (staff and drivers see it)
          <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Bus broke down at Elm St" />
        </label>
        <div className="row">
          <button type="button" className="btn" disabled={busy} onClick={cancel}>
            Cancel run
          </button>
          <label style={{ flex: "1 1 10rem" }}>
            Replacement bus
            <select value={spare} onChange={(e) => setSpare(e.target.value)}>
              <option value="">Choose a free bus</option>
              {spares.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                  {d.busLabel ? ` (${d.busLabel})` : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" disabled={busy || !spare} onClick={replace} style={{ alignSelf: "flex-end" }}>
            Send replacement
          </button>
        </div>
        <Outcome outcome={outcome} />
      </div>
    </details>
  );
}

// MARK: Maintenance windows (docs/14 §5)

function MaintenanceSection({ source, devices }: { source: StaffSource; devices: DeviceSummary[] }) {
  const { state } = useStaffQuery<Ready<ListMaintenanceResult>>(source, "fleet:listMaintenance");
  const usable = devices.filter((d) => !d.revoked);
  const [deviceId, setDeviceId] = useState("");
  const [start, setStart] = useState("");
  const [hours, setHours] = useState("2");
  const [reason, setReason] = useState("");
  const { busy, outcome, run } = useMutation(source);
  const window_ = maintenanceWindow(start, Number(hours));
  return (
    <details className="card stack maintenance">
      <summary>
        <strong>Maintenance windows</strong>
      </summary>
      <p className="muted small">
        When a bus&apos;s software may be updated. The Pi&apos;s update tool still refuses to switch during an active run.
      </p>
      <Loaded state={state}>
        {({ windows }) =>
          windows.length === 0 ? (
            <Empty text="No upcoming maintenance." />
          ) : (
            <ul className="stack" style={{ gap: "var(--space-sm)", margin: 0, paddingLeft: "var(--space-lg)" }}>
              {windows.map((w) => (
                <li key={w.windowId}>
                  <strong>{w.deviceLabel}</strong>: {dateTime(w.startsAtMs)} to {dateTime(w.endsAtMs)}: {w.reason}
                  <span className="muted small"> · Scheduled by {w.scheduledByName ?? "unknown"}.</span>{" "}
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void run("fleet:cancelMaintenance", { windowId: w.windowId }, "Window cancelled.")}
                  >
                    Cancel window
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!window_) return;
          void run("fleet:scheduleMaintenance", { deviceId, ...window_, reason }, "Maintenance scheduled.");
        }}
      >
        <label style={{ flex: "1 1 10rem" }}>
          Device
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">Choose a device</option>
            {usable.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: "1 1 12rem" }}>
          Starts
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label style={{ flex: "0 1 6rem" }}>
          Hours
          <input type="number" min={0.5} max={12} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} />
        </label>
        <label style={{ flex: "2 1 14rem" }}>
          Reason
          <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Software update" />
        </label>
        <button type="submit" className="btn" disabled={busy || !deviceId || !window_} style={{ alignSelf: "flex-end" }}>
          Schedule
        </button>
      </form>
      <Outcome outcome={outcome} />
    </details>
  );
}

// MARK: Service calendar (docs/12 §3, §7)

const DAY_STATUS_LABEL = { no_service: "No service", late_start: "Late start" } as const;
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function CalendarPage({ source }: { source: StaffSource }) {
  const { state } = useStaffQuery<Ready<ListServiceDaysResult>>(source, "calendar:listDays");
  const [date, setDate] = useState("");
  const [status, setStatus] = useState<"no_service" | "late_start">("no_service");
  const [minutes, setMinutes] = useState("120");
  const [notice, setNotice] = useState("");
  const { busy, outcome, run } = useMutation(source);
  return (
    <section className="card stack">
      <h1>Service calendar</h1>
      <p className="muted small">
        Days with no service or a late start. Every other day runs normally. Past days can&apos;t be changed. Family
        apps don&apos;t show these notices yet, so also send them through the school&apos;s usual channel.
      </p>
      <Loaded state={state}>
        {({ days }) =>
          days.length === 0 ? (
            <Empty text="No closures or late starts are planned." />
          ) : (
            <div className="stack" style={{ gap: "var(--space-sm)" }}>
              {days.map((d) => (
                <article key={d.serviceDate} className="card stack" style={{ gap: "var(--space-xs)" }}>
                  <div className="row spread">
                    <h2>{serviceDateLabel(d.serviceDate)}</h2>
                    <span className="badge">
                      {DAY_STATUS_LABEL[d.status]}
                      {d.lateStartMinutes !== null && `: ${d.lateStartMinutes} min`}
                    </span>
                  </div>
                  <p>{d.notice}</p>
                  <p className="muted small">
                    {d.serviceDate} ({d.timezone}). Set by {d.setByName ?? "unknown"}, {dateTime(d.setAtMs)}.
                  </p>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    style={{ alignSelf: "flex-start" }}
                    onClick={() => {
                      if (window.confirm(`Return ${d.serviceDate} to a normal operating day?`)) {
                        void run("calendar:removeDay", { serviceDate: d.serviceDate }, "Back to a normal day.");
                      }
                    }}
                  >
                    Remove
                  </button>
                </article>
              ))}
            </div>
          )
        }
      </Loaded>
      <form
        className="card stack"
        style={{ gap: "var(--space-sm)" }}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            "calendar:setDay",
            {
              serviceDate: date,
              timezone: DEFAULT_TIMEZONE,
              status,
              notice,
              ...(status === "late_start" ? { lateStartMinutes: Number(minutes) } : {}),
            },
            "Saved.",
          );
        }}
      >
        <h2>Add or change a day</h2>
        <div className="row">
          <label style={{ flex: "1 1 10rem" }}>
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label style={{ flex: "1 1 10rem" }}>
            Service
            <select value={status} onChange={(e) => setStatus(e.target.value as "no_service" | "late_start")}>
              <option value="no_service">No service</option>
              <option value="late_start">Late start</option>
            </select>
          </label>
          {status === "late_start" && (
            <label style={{ flex: "0 1 8rem" }}>
              Minutes late
              <input type="number" min={1} max={240} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </label>
          )}
        </div>
        <label>
          Notice for families
          <input value={notice} maxLength={200} onChange={(e) => setNotice(e.target.value)} placeholder="Snow day: no buses" />
        </label>
        <p className="muted small">Time zone: {DEFAULT_TIMEZONE}</p>
        <button type="submit" className="btn btn-primary" disabled={busy || !date} style={{ alignSelf: "flex-start" }}>
          Save day
        </button>
        <Outcome outcome={outcome} />
      </form>
    </section>
  );
}
