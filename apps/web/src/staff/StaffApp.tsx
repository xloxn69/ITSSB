import type {
  DeviceSummary,
  DiagnosticsResult,
  DraftDetail,
  GetDraftResult,
  ListDevicesResult,
  ListDraftsResult,
  ListDriversResult,
  ListRoutesResult,
} from "@itssb/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { DraftDiagram } from "./DraftDiagram";
import { approvalBlocker, contactStatus, DIRECTION_LABEL, dateTime, sweepSummary } from "./format";
import {
  type CredentialOutcome,
  credentialOutcome,
  type MutationOutcome,
  mutationOutcome,
  type QueryState,
  queryState,
  type StaffActionName,
  type StaffMutationName,
  type StaffQueryName,
  type StaffSource,
} from "./source";

type Ready<T> = Extract<T, { status: "ready" }>;

/** Staff console (docs/12 §3–4). The server checks the staff role on every call. */
export function StaffApp({ source }: { source: StaffSource }) {
  const route = useHashRoute();
  const parts = route.split("/").filter(Boolean); // ["staff", page, id?]
  const page = parts[1] ?? "routes";
  const tabs: [string, string][] = [
    ["routes", "Routes"],
    ["review", "Route review"],
    ["devices", "Buses & devices"],
    ["drivers", "Drivers"],
    ["diagnostics", "Diagnostics"],
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
      {page === "drivers" && <DriversPage source={source} />}
      {page === "diagnostics" && <DiagnosticsPage source={source} />}
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

interface Received<T> {
  state: QueryState<T>;
  receivedAtWallMs: number;
}

function useStaffQuery<T>(source: StaffSource, name: StaffQueryName, args: Record<string, string> = {}): Received<T> {
  const key = JSON.stringify(args);
  const [received, setReceived] = useState<Received<T>>({ state: { kind: "loading" }, receivedAtWallMs: 0 });
  useEffect(() => {
    setReceived({ state: { kind: "loading" }, receivedAtWallMs: 0 });
    return source.watch(
      name,
      JSON.parse(key) as Record<string, string>,
      (raw) => setReceived({ state: queryState<T>(raw), receivedAtWallMs: Date.now() }),
      () => setReceived({ state: { kind: "failed" }, receivedAtWallMs: Date.now() }),
    );
  }, [source, name, key]);
  return received;
}

/** Renders the non-ready states the same way on every page. */
function Loaded<T>({ state, children }: { state: QueryState<T>; children: (value: T) => ReactNode }) {
  switch (state.kind) {
    case "loading":
      return (
        <section className="card message" aria-busy>
          <h2>Loading…</h2>
        </section>
      );
    case "access_unavailable":
      return state.reason === "unauthenticated" ? (
        <Notice title="Signed out" detail="Sign in again with a staff account." />
      ) : (
        <Notice title="Staff access needed" detail="This account isn't a staff account. Ask an administrator for access." />
      );
    case "not_found":
      return <Notice title="Not found" detail="It may have been removed, or the link is wrong." />;
    case "failed":
      return (
        <Notice
          title="Something went wrong"
          detail="Couldn't load this from the server. Nothing shown here is assumed. Check your connection and reload."
        />
      );
    case "ready":
      return <>{children(state.value)}</>;
  }
}

function Notice({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="card message">
      <h2>{title}</h2>
      <p className="muted">{detail}</p>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="muted">{text}</p>;
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

function useMutation(source: StaffSource) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<MutationOutcome | null>(null);
  async function run(name: StaffMutationName, args: Record<string, string>, done: string) {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(mutationOutcome(await source.mutate(name, args), done));
    } catch {
      // The outcome is unknown, not failed: the server may have applied it.
      setOutcome({ kind: "failed", message: "No answer from the server. Reload to see whether it was applied." });
    } finally {
      setBusy(false);
    }
  }
  return { busy, outcome, run };
}

function Outcome({ outcome }: { outcome: MutationOutcome | null }) {
  if (!outcome) return null;
  const text =
    outcome.kind === "access_unavailable"
      ? outcome.reason === "unauthenticated"
        ? "You're signed out. Sign in again with a staff account."
        : "This account isn't a staff account."
      : outcome.message;
  return (
    <p role="status" className={outcome.kind === "done" ? "" : "error-text"}>
      {text}
    </p>
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
          <DraftDiagram path={draft.path} stops={draft.stops} label={draft.label} />
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

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

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
              {devices.map((d) => (
                <DeviceRow
                  key={d.deviceId}
                  source={source}
                  device={d}
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
  serverNowMs,
  receivedAtWallMs,
}: {
  source: StaffSource;
  device: DeviceSummary;
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

// MARK: Drivers

function DriversPage({ source }: { source: StaffSource }) {
  const { state } = useStaffQuery<Ready<ListDriversResult>>(source, "fleet:listDrivers");
  return (
    <section className="card stack">
      <h1>Drivers</h1>
      <p className="muted small">People with a driver account. Driving permission comes from a driver grant on the bus.</p>
      <Loaded state={state}>
        {({ drivers }) =>
          drivers.length === 0 ? (
            <Empty text="No driver accounts yet." />
          ) : (
            <ul style={{ margin: 0, paddingLeft: "var(--space-xl)" }}>
              {drivers.map((d) => (
                <li key={d.userId}>{d.displayName}</li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </section>
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
        Run IDs, contact ages and versions for support. No positions, addresses or credentials are shown here.
      </p>
      <Loaded state={state}>
        {({ deployment, retention, devices, serverNowMs }) => (
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
                      </dl>
                    </article>
                  );
                })}
              </div>
            )}
            <p className="muted small">
              Software and upload queue come from each device&apos;s latest heartbeat; read them with its contact age.
            </p>
          </div>
        )}
      </Loaded>
    </section>
  );
}
