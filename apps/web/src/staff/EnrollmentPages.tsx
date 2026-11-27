import {
  type CheckInRecord,
  type CheckInSource,
  type EnrollmentRequestForReview,
  formatToken,
  type GuardianLinkRequestForReview,
  type ListAuditResult,
  type ListEnrollmentRequestsResult,
  type ListGuardianLinkRequestsResult,
  type ListInvitationsResult,
  type ListRoutesResult,
  type ListStudentsResult,
  type RecentRunsResult,
  type RequestStatus,
  type RunAttendanceResult,
  type RunAttendanceStudent,
  type StudentSummary,
  TOKEN_LINK_PATHS,
} from "@itssb/contracts";
import { useState } from "react";
import { DIRECTION_LABEL, dateTime } from "./format";
import type { StaffSource } from "./source";
import { Empty, Loaded, Outcome, type Ready, useMutation, useStaffQuery } from "./ui";

/**
 * Staff pages for enrollment, guardian links, invitations, students,
 * attendance and audit (docs/09, docs/12). The server checks the staff role
 * on every call; these pages show its answers, including refusals.
 */

const DAY = 24 * 60 * 60 * 1000;

const REQUEST_LABEL: Record<RequestStatus, string> = {
  pending: "Waiting for review",
  approved: "Approved",
  rejected: "Rejected",
};

/** The words for where an attendance record came from. Never "verified boarding". */
export const SOURCE_LABEL: Record<CheckInSource, string> = {
  student_qr_claim: "Student QR claim",
  staff_recorded: "Staff recorded",
  staff_correction: "Staff correction",
};

export function recordText(record: CheckInRecord | null): string {
  if (!record) return "Nothing recorded";
  const what = record.status === "boarded" ? "Boarded" : "Not boarded";
  return `${what} · ${SOURCE_LABEL[record.source]} · ${dateTime(record.recordedAtMs)}`;
}

/** One stable request identity per attempt, so a retry after a timeout reuses it. */
function useRequestId(): [string, () => void] {
  const [id, setId] = useState(() => crypto.randomUUID());
  return [id, () => setId(crypto.randomUUID())];
}

// MARK: Enrollment requests

export function EnrollmentPage({ source }: { source: StaffSource }) {
  const { state } = useStaffQuery<Ready<ListEnrollmentRequestsResult>>(source, "enrollment:listRequests");
  return (
    <section className="card stack">
      <h1>Enrollment requests</h1>
      <p className="muted small">
        Families ask to join a route with the student's name and address. Nobody can track a bus until you approve.
        Addresses are private: they appear only here.
      </p>
      <Loaded state={state}>
        {({ requests }) =>
          requests.length === 0 ? (
            <Empty text="No enrollment requests yet. They appear here when a family uses a route invitation." />
          ) : (
            <div className="stack">
              {requests.map((r) => (
                <EnrollmentRequestCard key={r.enrollmentRequestId} source={source} request={r} />
              ))}
            </div>
          )
        }
      </Loaded>
    </section>
  );
}

function EnrollmentRequestCard({ source, request: r }: { source: StaffSource; request: EnrollmentRequestForReview }) {
  const { busy, outcome, run } = useMutation(source);
  const [stopId, setStopId] = useState(r.requestedStopId ?? "");
  const [reason, setReason] = useState("");
  const approve = () => {
    const stop = r.eligibleStops.find((s) => s.stopId === stopId);
    if (!stop) return;
    if (window.confirm(`Approve ${r.studentName} on ${r.routeLabel} at ${stop.label}? They can then track this route.`)) {
      void run("enrollment:approve", { enrollmentRequestId: r.enrollmentRequestId, stopId }, "Approved. The family can now track this route.");
    }
  };
  return (
    <article className="card stack" style={{ gap: "var(--space-sm)" }}>
      <div className="row spread">
        <h2>{r.studentName}</h2>
        <span className="badge">{REQUEST_LABEL[r.status]}</span>
      </div>
      <p className="muted small">
        {r.routeLabel} · {DIRECTION_LABEL[r.direction]} · submitted {dateTime(r.submittedAtMs)}
      </p>
      <dl className="stack flush" style={{ gap: "var(--space-xs)" }}>
        <div>
          <dt className="muted small">Address (private)</dt>
          <dd className="flush">{r.address}</dd>
        </div>
        <div>
          <dt className="muted small">Requested stop</dt>
          <dd className="flush">{r.requestedStopLabel ?? "None fit — needs your choice"}</dd>
        </div>
        {r.note && (
          <div>
            <dt className="muted small">Note from the family</dt>
            <dd className="flush">{r.note}</dd>
          </div>
        )}
      </dl>
      {r.status === "pending" ? (
        <>
          <label>
            Approve at stop
            <select value={stopId} onChange={(e) => setStopId(e.target.value)}>
              <option value="">Choose an approved stop…</option>
              {r.eligibleStops.map((s) => (
                <option key={s.stopId} value={s.stopId}>
                  {s.sequence + 1}. {s.label}
                </option>
              ))}
            </select>
          </label>
          {r.eligibleStops.length === 0 && <p className="muted small">This route has no approved stops, so it can't be approved yet.</p>}
          <button type="button" className="btn btn-primary" disabled={busy || !stopId} onClick={approve}>
            Approve
          </button>
          <label>
            Reason for rejecting (shown to the family)
            <textarea rows={2} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn"
            disabled={busy || !reason.trim()}
            onClick={() => void run("enrollment:reject", { enrollmentRequestId: r.enrollmentRequestId, reason }, "Rejected. The family sees your reason.")}
          >
            Reject with this reason
          </button>
        </>
      ) : (
        <p className="muted small">
          {REQUEST_LABEL[r.status]}
          {r.reviewerName && ` by ${r.reviewerName}`} · {dateTime(r.decidedAtMs)}
          {r.decisionReason && ` · ${r.decisionReason}`}
        </p>
      )}
      <Outcome outcome={outcome} />
    </article>
  );
}

// MARK: Guardian link requests

export function GuardianLinksPage({ source }: { source: StaffSource }) {
  const { state } = useStaffQuery<Ready<ListGuardianLinkRequestsResult>>(source, "guardianLinks:listRequests");
  return (
    <section className="card stack">
      <h1>Guardian link requests</h1>
      <p className="muted small">
        A guardian redeems a single-use invitation you issued for one student. Check them against school records before
        approving. Knowing a student's name is never enough.
      </p>
      <Loaded state={state}>
        {({ requests }) =>
          requests.length === 0 ? (
            <Empty text="No link requests. Issue a guardian invitation from Students." />
          ) : (
            <div className="stack">
              {requests.map((r) => (
                <LinkRequestCard key={r.linkRequestId} source={source} request={r} />
              ))}
            </div>
          )
        }
      </Loaded>
    </section>
  );
}

function LinkRequestCard({ source, request: r }: { source: StaffSource; request: GuardianLinkRequestForReview }) {
  const { busy, outcome, run } = useMutation(source);
  const [reason, setReason] = useState("");
  return (
    <article className="card stack" style={{ gap: "var(--space-sm)" }}>
      <div className="row spread">
        <h2>
          {r.guardianName} <span className="muted">for {r.studentDisplayName}</span>
        </h2>
        <span className="badge">{REQUEST_LABEL[r.status]}</span>
      </div>
      <p className="muted small">Submitted {dateTime(r.submittedAtMs)}</p>
      {r.status === "pending" ? (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Link ${r.guardianName} to ${r.studentDisplayName}? They will see this student's bus.`)) {
                void run("guardianLinks:approve", { linkRequestId: r.linkRequestId }, "Linked. The guardian can now see this student's bus.");
              }
            }}
          >
            Approve link
          </button>
          <label>
            Reason for rejecting
            <textarea rows={2} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn"
            disabled={busy || !reason.trim()}
            onClick={() => void run("guardianLinks:reject", { linkRequestId: r.linkRequestId, reason }, "Rejected.")}
          >
            Reject with this reason
          </button>
        </>
      ) : (
        <p className="muted small">
          {REQUEST_LABEL[r.status]}
          {r.reviewerName && ` by ${r.reviewerName}`} · {dateTime(r.decidedAtMs)}
          {r.decisionReason && ` · ${r.decisionReason}`}
        </p>
      )}
      <Outcome outcome={outcome} />
    </article>
  );
}

// MARK: Invitations

/** A code shown once, right after it is created. It is never shown again. */
function CreatedCode({ raw, purpose }: { raw: unknown; purpose: "route_enrollment" | "guardian_link" }) {
  const created = raw as { status?: unknown; token?: unknown; expiresAtMs?: unknown } | null;
  if (created?.status !== "created" || typeof created.token !== "string" || typeof created.expiresAtMs !== "number") return null;
  return (
    <div className="card stack" style={{ gap: "var(--space-xs)" }} role="status">
      <p className="muted small">Copy this now. It won't be shown again.</p>
      <p className="code-display">
        {formatToken(created.token)}
      </p>
      <p className="muted small">
        Families type it in the app, or open {TOKEN_LINK_PATHS[purpose]}?token=… on the school's link. Expires{" "}
        {dateTime(created.expiresAtMs)}.
      </p>
    </div>
  );
}

export function InvitationsPage({ source }: { source: StaffSource }) {
  const routes = useStaffQuery<Ready<ListRoutesResult>>(source, "routes:list");
  const { state } = useStaffQuery<Ready<ListInvitationsResult>>(source, "enrollment:listInvitations");
  const { busy, outcome, last, act } = useMutation(source);
  const [routeId, setRouteId] = useState("");
  const [days, setDays] = useState("7");
  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="new-invite">
        <h1 id="new-invite">Route invitation</h1>
        <p className="muted small">
          One code for a route. Families who use it can ask to join; you still approve each request. Drivers can also show
          one on the bus.
        </p>
        <Loaded state={routes.state}>
          {({ routes: list }) => (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void act("enrollment:createRouteInvitation", { routeId, ttlMs: Number(days) * DAY }, "Invitation created.");
              }}
            >
              <label>
                Route
                <select value={routeId} onChange={(e) => setRouteId(e.target.value)}>
                  <option value="">Choose a route…</option>
                  {list
                    .filter((r) => r.currentVersion)
                    .map((r) => (
                      <option key={r.routeId} value={r.routeId}>
                        {r.label} · {DIRECTION_LABEL[r.direction]}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Valid for
                <select value={days} onChange={(e) => setDays(e.target.value)}>
                  <option value="1">1 day</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                </select>
              </label>
              <button type="submit" className="btn btn-primary" disabled={busy || !routeId}>
                Create invitation
              </button>
            </form>
          )}
        </Loaded>
        <CreatedCode raw={last} purpose="route_enrollment" />
        <Outcome outcome={outcome} />
      </section>
      <section className="card stack">
        <h2>Issued invitations</h2>
        <Loaded state={state}>
          {({ invitations, serverNowMs }) =>
            invitations.length === 0 ? (
              <Empty text="No invitations yet." />
            ) : (
              <table className="responsive-table">
                <thead>
                  <tr>
                    <th>For</th>
                    <th>Kind</th>
                    <th>State</th>
                    <th>Issued</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((i) => (
                    <InvitationRow key={i.invitationId} source={source} invitation={i} serverNowMs={serverNowMs} />
                  ))}
                </tbody>
              </table>
            )
          }
        </Loaded>
      </section>
    </div>
  );
}

function InvitationRow({
  source,
  invitation: i,
  serverNowMs,
}: {
  source: StaffSource;
  invitation: Ready<ListInvitationsResult>["invitations"][number];
  serverNowMs: number;
}) {
  const { busy, outcome, run } = useMutation(source);
  const state = i.revoked
    ? "Revoked"
    : i.usedAtMs !== null
      ? `Used ${dateTime(i.usedAtMs)}`
      : i.expiresAtMs <= serverNowMs
        ? "Expired"
        : `Valid until ${dateTime(i.expiresAtMs)}`;
  const live = !i.revoked && i.usedAtMs === null && i.expiresAtMs > serverNowMs;
  return (
    <tr>
      <td data-label="For">{i.routeLabel ?? i.studentDisplayName ?? "—"}</td>
      <td data-label="Kind">{i.purpose === "route_enrollment" ? "Route" : "Guardian (single use)"}</td>
      <td data-label="State">{state}</td>
      <td data-label="Issued">
        {dateTime(i.issuedAtMs)}
        {i.issuedByName && <div className="muted small">by {i.issuedByName}</div>}
      </td>
      <td data-label="">
        {live && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Revoke this invitation? Anyone holding it can no longer use it.")) {
                void run("enrollment:revokeInvitation", { invitationId: i.invitationId }, "Revoked.");
              }
            }}
          >
            Revoke
          </button>
        )}
        <Outcome outcome={outcome} />
      </td>
    </tr>
  );
}

// MARK: Students

export function StudentsPage({ source }: { source: StaffSource }) {
  const { state } = useStaffQuery<Ready<ListStudentsResult>>(source, "students:list");
  return (
    <section className="card stack">
      <h1>Students</h1>
      <p className="muted small">
        Removing a student from a route ends only that assignment. Their account, other routes, guardians and attendance
        history stay.
      </p>
      <Loaded state={state}>
        {({ students }) =>
          students.length === 0 ? (
            <Empty text="No students yet. They appear when you approve an enrollment request." />
          ) : (
            <div className="stack">
              {students.map((s) => (
                <StudentCard key={s.studentId} source={source} student={s} />
              ))}
            </div>
          )
        }
      </Loaded>
    </section>
  );
}

function StudentCard({ source, student: s }: { source: StaffSource; student: StudentSummary }) {
  const invite = useMutation(source);
  return (
    <article className="card stack" style={{ gap: "var(--space-sm)" }}>
      <div className="row spread">
        <h2>{s.displayName}</h2>
        <span className="muted small">{s.hasOwnAccount ? "Has own account" : "No phone account"}</span>
      </div>
      <h3 className="small">Routes</h3>
      {s.assignments.length === 0 ? (
        <Empty text="Not on any route." />
      ) : (
        s.assignments.map((a) => <AssignmentRow key={a.assignmentId} source={source} studentName={s.displayName} assignment={a} />)
      )}
      <h3 className="small">Guardians</h3>
      {s.guardians.length === 0 ? (
        <Empty text="No linked guardians." />
      ) : (
        s.guardians.map((g) => <GuardianRow key={g.guardianLinkId} source={source} guardian={g} studentName={s.displayName} />)
      )}
      <button
        type="button"
        className="btn"
        disabled={invite.busy}
        onClick={() => void invite.act("guardianLinks:createInvitation", { studentId: s.studentId, ttlMs: 7 * DAY }, "Guardian invitation created.")}
      >
        Create guardian invitation
      </button>
      <CreatedCode raw={invite.last} purpose="guardian_link" />
      <Outcome outcome={invite.outcome} />
    </article>
  );
}

function AssignmentRow({
  source,
  studentName,
  assignment: a,
}: {
  source: StaffSource;
  studentName: string;
  assignment: StudentSummary["assignments"][number];
}) {
  const { busy, outcome, run } = useMutation(source);
  const [requestId] = useRequestId();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <div className="stack" style={{ gap: "var(--space-xs)" }}>
      <p className="flush">
        {a.routeLabel}
        {a.direction && ` · ${DIRECTION_LABEL[a.direction]}`} · {a.stopLabel}{" "}
        {a.status === "revoked" && <span className="badge">Removed</span>}
      </p>
      {a.status === "approved" && !open && (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Remove from this route…
        </button>
      )}
      {a.status === "approved" && open && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const message = `Remove ${studentName} from ${a.routeLabel}? They stop seeing this route. Their account, guardians and history stay.`;
            if (window.confirm(message)) {
              void run("routes:removeAssignment", { requestId, assignmentId: a.assignmentId, reason }, "Removed from this route.");
            }
          }}
        >
          <label>
            Reason (required)
            <textarea rows={2} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="submit" className="btn" disabled={busy || !reason.trim()}>
            Remove {studentName} from {a.routeLabel}
          </button>
        </form>
      )}
      <Outcome outcome={outcome} />
    </div>
  );
}

function GuardianRow({
  source,
  guardian: g,
  studentName,
}: {
  source: StaffSource;
  guardian: StudentSummary["guardians"][number];
  studentName: string;
}) {
  const { busy, outcome, run } = useMutation(source);
  const [reason, setReason] = useState("");
  return (
    <div className="stack" style={{ gap: "var(--space-xs)" }}>
      <p className="flush">
        {g.guardianName} {g.status === "revoked" && <span className="badge">Link removed</span>}
      </p>
      {g.status === "approved" && (
        <div className="row">
          <label style={{ flex: "1 1 12rem" }}>
            Reason to remove link
            <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn"
            disabled={busy || !reason.trim()}
            style={{ alignSelf: "flex-end" }}
            onClick={() => {
              if (window.confirm(`Remove ${g.guardianName}'s link to ${studentName}? They stop seeing this student's bus.`)) {
                void run("guardianLinks:revoke", { guardianLinkId: g.guardianLinkId, reason }, "Link removed.");
              }
            }}
          >
            Remove link
          </button>
        </div>
      )}
      <Outcome outcome={outcome} />
    </div>
  );
}

// MARK: Attendance

export function AttendancePage({ source }: { source: StaffSource }) {
  const { state } = useStaffQuery<Ready<RecentRunsResult>>(source, "checkIns:recentRuns");
  return (
    <section className="card stack">
      <h1>Attendance</h1>
      <p className="muted small">
        A check-in records a student's QR claim or a staff action. It does not prove a child boarded.
      </p>
      <Loaded state={state}>
        {({ runs }) =>
          runs.length === 0 ? (
            <Empty text="No trips yet." />
          ) : (
            <table className="responsive-table">
              <thead>
                <tr>
                  <th>Trip</th>
                  <th>State</th>
                  <th>Started</th>
                  <th>Recorded boarded</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.runId}>
                    <td data-label="Trip">
                      <a href={`#/staff/attendance/${encodeURIComponent(r.runId)}`}>{r.routeLabel}</a>
                      {r.busLabel && <div className="muted small">{r.busLabel}</div>}
                    </td>
                    <td data-label="State">
                      <span className="badge">{r.state === "active" ? "Running" : r.state === "completed" ? "Finished" : r.state}</span>
                    </td>
                    <td data-label="Started">{dateTime(r.startedAtMs)}</td>
                    <td data-label="Recorded boarded">
                      {r.boardedCount} of {r.assignedCount}
                    </td>
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

export function RunAttendancePage({ source, runId }: { source: StaffSource; runId: string }) {
  const { state } = useStaffQuery<Ready<RunAttendanceResult>>(source, "checkIns:runAttendance", { runId });
  return (
    <div className="stack">
      <a href="#/staff/attendance" className="small">
        ← Attendance
      </a>
      <Loaded state={state}>
        {(run) => (
          <section className="card stack">
            <h1>{run.routeLabel}</h1>
            <p className="muted small">
              {run.runState === "active" ? "Running now" : run.runState === "completed" ? "Finished" : run.runState} · started{" "}
              {dateTime(run.startedAtMs)}
            </p>
            {run.students.length === 0 ? (
              <Empty text="No students are assigned to this route." />
            ) : (
              run.students.map((s) => (
                <AttendanceRow key={s.assignmentId} source={source} runId={run.runId} active={run.runState === "active"} student={s} />
              ))
            )}
          </section>
        )}
      </Loaded>
    </div>
  );
}

function AttendanceRow({
  source,
  runId,
  active,
  student: s,
}: {
  source: StaffSource;
  runId: string;
  active: boolean;
  student: RunAttendanceStudent;
}) {
  const { busy, outcome, run } = useMutation(source);
  const record = (status: "boarded" | "not_boarded") =>
    void run("checkIns:staffRecord", { runId, assignmentId: s.assignmentId, status }, "Recorded as a staff action.");
  return (
    <article className="card stack" style={{ gap: "var(--space-xs)" }}>
      <div className="row spread">
        <h2>{s.studentDisplayName}</h2>
        <span className="muted small">
          {s.stopLabel}
          {s.seatLabel && ` · seat ${s.seatLabel}`}
        </span>
      </div>
      <p className="status flush">
        <span className={`dot tone-${s.current ? (s.current.status === "boarded" ? "fresh" : "aging") : "unknown"}`} aria-hidden />
        <span>{recordText(s.current)}</span>
      </p>
      {s.driverNote && <p className="muted small">Driver note: {s.driverNote}</p>}
      {s.history.length > 1 && (
        <details>
          <summary className="small">History ({s.history.length})</summary>
          <ol className="small" style={{ margin: 0, paddingLeft: "var(--space-xl)" }}>
            {s.history.map((h) => (
              <li key={h.checkInId}>
                {recordText(h)}
                {h.recordedByName && ` · by ${h.recordedByName}`}
                {h.reason && ` · ${h.reason}`}
              </li>
            ))}
          </ol>
        </details>
      )}
      {active && !s.current && (
        <div className="row">
          <button type="button" className="btn" disabled={busy} onClick={() => record("boarded")}>
            Record boarded
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => record("not_boarded")}>
            Record not boarded
          </button>
        </div>
      )}
      <Outcome outcome={outcome} />
    </article>
  );
}

// MARK: Audit

export function AuditPage({ source }: { source: StaffSource }) {
  const { state } = useStaffQuery<Ready<ListAuditResult>>(source, "audit:list");
  return (
    <section className="card stack">
      <h1>Audit log</h1>
      <p className="muted small">Who did what, when, and from where. It never holds codes or addresses.</p>
      <Loaded state={state}>
        {({ entries }) =>
          entries.length === 0 ? (
            <Empty text="Nothing recorded yet." />
          ) : (
            <table className="responsive-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.auditId}>
                    <td data-label="When">
                      {dateTime(e.atMs)}
                      {e.capturedAtMs !== null && <div className="muted small">done {dateTime(e.capturedAtMs)} on the bus</div>}
                    </td>
                    <td data-label="Who">
                      {e.actorName}
                      {e.source && <div className="muted small">{SOURCE_WORDS[e.source] ?? e.source}</div>}
                    </td>
                    <td data-label="Action">
                      {e.action}
                      {e.reason && <div className="muted small">{e.reason}</div>}
                    </td>
                    <td data-label="Result">{e.result === "allowed" ? "Allowed" : "Denied"}</td>
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

const SOURCE_WORDS: Record<string, string> = {
  staff_web: "Staff console",
  family_app: "Family app",
  driver_device: "Driver screen",
};
