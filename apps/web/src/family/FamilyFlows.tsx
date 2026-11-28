import {
  type AssignmentCheckInResult,
  type EligibleStop,
  MAX_ADDRESS_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_STUDENT_NAME_LENGTH,
  normalizeToken,
  type MyAssignmentsResult,
  type MyEnrollmentRequestsResult,
  type MyGuardianLinkRequestsResult,
  type PreviewInvitationResult,
  parseScannedToken,
  type RequestStatus,
  type TokenPurpose,
} from "@itssb/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { DIRECTION_LABEL, dateTime } from "../staff/format";
import { type CommandView, checkInLine, commandView, TOKEN_PROBLEM_TEXT } from "./enrollmentModel";
import type { FamilyArgs, FamilyQueryName, FamilySource } from "./familySource";

/**
 * Family enrollment, guardian linking and trip check-in on the web
 * (docs/09 §4–§6; iOS I05–I08, I17–I18). Every answer comes from the server;
 * a pending request grants nothing, and nothing is shown as sent until the
 * server says so.
 */

type Loadable<T> = { kind: "loading" } | { kind: "ready"; value: T } | { kind: "failed" };

function useFamilyQuery<T>(source: FamilySource, name: FamilyQueryName, args: FamilyArgs | null): Loadable<T> {
  const key = args ? JSON.stringify(args) : null;
  const [state, setState] = useState<Loadable<T>>({ kind: "loading" });
  useEffect(() => {
    setState({ kind: "loading" });
    if (key === null) return;
    return source.watch(
      name,
      JSON.parse(key) as FamilyArgs,
      (raw) => setState({ kind: "ready", value: raw as T }),
      () => setState({ kind: "failed" }),
    );
  }, [source, name, key]);
  return state;
}

/** A request identity created once per attempt and reused on every retry of it. */
function useRequestId(): [string] {
  const [id] = useState(() => crypto.randomUUID());
  return [id];
}

function useCommand(source: FamilySource) {
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<CommandView | null>(null);
  async function send(name: Parameters<FamilySource["mutate"]>[0], args: FamilyArgs) {
    setBusy(true);
    try {
      setView(commandView(await source.mutate(name, args)));
    } catch {
      // The server may or may not have it. Say so; the retry reuses the same requestId.
      setView({ kind: "unconfirmed" });
    } finally {
      setBusy(false);
    }
  }
  return { busy, view, send, reset: () => setView(null) };
}

function Card({ title, children, busy }: { title: string; children?: ReactNode; busy?: boolean }) {
  return (
    <section className="card stack" aria-busy={busy}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Problem({ view, onRetry }: { view: CommandView; onRetry?: () => void }) {
  switch (view.kind) {
    case "token_problem": {
      const t = TOKEN_PROBLEM_TEXT[view.problem];
      return (
        <Card title={t.title}>
          <p className="muted">{t.detail}</p>
        </Card>
      );
    }
    case "refused":
      return (
        <Card title="Not accepted">
          <p className="muted">{view.message}</p>
        </Card>
      );
    case "signed_out":
      return (
        <Card title="Signed out">
          <p className="muted">Sign in again, then send it again. Nothing was sent.</p>
        </Card>
      );
    case "not_permitted":
      return (
        <Card title="Not available for this account">
          <p className="muted">This account can't do that. Ask your school.</p>
        </Card>
      );
    case "unconfirmed":
      return (
        <Card title="Not confirmed yet">
          <p className="muted">
            We couldn't reach the school's system, so we don't know whether it arrived. Try again: it won't be sent twice.
          </p>
          {onRetry && (
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              Try again
            </button>
          )}
        </Card>
      );
    default:
      return null;
  }
}

/** Accepts a typed code or a pasted link; the server still validates it. */
function CodeField({
  purpose,
  label,
  initial,
  onCode,
}: {
  purpose: TokenPurpose;
  label: string;
  initial: string;
  onCode: (token: string | null) => void;
}) {
  const [text, setText] = useState(initial);
  const token = text.trim() ? parseScannedToken(text, purpose, [location.host]) : null;
  useEffect(() => onCode(token), [token, onCode]);
  return (
    <label>
      {label}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="ABCD-EFGH-JKMN-PQRS-TVWX"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        inputMode="text"
      />
      {text.trim() && !token && <span className="error-text small">That doesn't look like a code. Check it and try again.</span>}
    </label>
  );
}

// MARK: Join a route

export function JoinPage({ source, initialCode }: { source: FamilySource; initialCode: string }) {
  const [token, setToken] = useState<string | null>(null);
  const preview = useFamilyQuery<PreviewInvitationResult>(source, "enrollment:previewInvitation", token ? { token } : null);
  return (
    <div className="stack">
      <header className="stack" style={{ gap: "var(--space-xs)" }}>
        <h1>Join a route</h1>
        <p className="muted">Enter the route code from your school or the bus. You'll see bus tracking after the school approves.</p>
      </header>
      <section className="card stack">
        <CodeField purpose="route_enrollment" label="Route code" initial={initialCode} onCode={setToken} />
      </section>
      {token && preview.kind === "loading" && <Card title="Checking the code…" busy />}
      {preview.kind === "failed" && (
        <Card title="Couldn't check the code">
          <p className="muted">Check your connection and try again.</p>
        </Card>
      )}
      {token && preview.kind === "ready" && <PreviewResult source={source} token={token} result={preview.value} />}
    </div>
  );
}

function PreviewResult({ source, token, result }: { source: FamilySource; token: string; result: PreviewInvitationResult }) {
  if (result.status === "token_problem") return <Problem view={{ kind: "token_problem", problem: result.problem }} />;
  if (result.status === "access_unavailable") return <Problem view={{ kind: "signed_out" }} />;
  return <RequestForm source={source} token={token} preview={result} />;
}

function RequestForm({
  source,
  token,
  preview,
}: {
  source: FamilySource;
  token: string;
  preview: Extract<PreviewInvitationResult, { status: "ready" }>;
}) {
  // The draft lives only in this page's memory: never in the URL or storage.
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [stopId, setStopId] = useState<string>("");
  const [note, setNote] = useState("");
  const [requestId] = useRequestId();
  const { busy, view, send, reset } = useCommand(source);
  const valid = name.trim() && address.trim() && stopId !== "";
  const submit = () =>
    void send("enrollment:request", {
      requestId,
      token,
      studentName: name,
      address,
      stopId: stopId === "none" ? null : stopId,
      note: note.trim() ? note : null,
    });

  if (view?.kind === "sent") {
    return (
      <Card title="Request sent">
        <p>The school has your request for {preview.routeLabel}. You'll be able to track the bus once it's approved.</p>
        <p className="muted small">Until then, this account can't see the bus.</p>
        <a className="btn" href="#/requests">
          See my requests
        </a>
      </Card>
    );
  }
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onChange={() => {
        // Clear an old refusal while editing. The request identity stays: the
        // server stores only accepted requests, and an unconfirmed one must
        // be resent unchanged (a changed resend is refused as a conflict).
        if (view && view.kind !== "unconfirmed") reset();
      }}
    >
      <h2>
        {preview.routeLabel} <span className="muted">· {DIRECTION_LABEL[preview.direction]}</span>
      </h2>
      <p className="muted small">Code valid until {dateTime(preview.expiresAtMs)}.</p>
      <label>
        Student's name
        <input value={name} maxLength={MAX_STUDENT_NAME_LENGTH} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </label>
      <label>
        Home address
        <input value={address} maxLength={MAX_ADDRESS_LENGTH} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" />
        <span className="muted small">Only school staff see this. It's used to check the right stop.</span>
      </label>
      <fieldset className="stack flush" style={{ border: "none", padding: 0, gap: "var(--space-xs)" }}>
        <legend>Pickup stop</legend>
        {preview.stops.map((s: EligibleStop) => (
          <label key={s.stopId} className="choice">
            <input type="radio" name="stop" value={s.stopId} checked={stopId === s.stopId} onChange={() => setStopId(s.stopId)} />
            <span>
              {s.label}
              {s.instructions && <span className="muted small"> · {s.instructions}</span>}
            </span>
          </label>
        ))}
        <label className="choice">
          <input type="radio" name="stop" value="none" checked={stopId === "none"} onChange={() => setStopId("none")} />
          <span>None of these fit — the school will choose</span>
        </label>
      </fieldset>
      <label>
        Note for the school (optional)
        <textarea rows={2} value={note} maxLength={MAX_NOTE_LENGTH} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy || !valid}>
        {busy ? "Sending…" : "Send request"}
      </button>
      {view && <Problem view={view} onRetry={submit} />}
    </form>
  );
}

// MARK: My requests

const STATUS_TEXT: Record<RequestStatus, string> = {
  pending: "Waiting for the school",
  approved: "Approved",
  rejected: "Not approved",
};

export function RequestsPage({ source }: { source: FamilySource }) {
  const enrollment = useFamilyQuery<MyEnrollmentRequestsResult>(source, "enrollment:myRequests", {});
  const links = useFamilyQuery<MyGuardianLinkRequestsResult>(source, "guardianLinks:myRequests", {});
  if (enrollment.kind === "loading" || links.kind === "loading") return <Card title="Loading your requests…" busy />;
  if (enrollment.kind === "failed" || links.kind === "failed") {
    return (
      <Card title="Couldn't load your requests">
        <p className="muted">Check your connection. Nothing here is assumed.</p>
      </Card>
    );
  }
  if (enrollment.value.status !== "ready" || links.value.status !== "ready") return <Problem view={{ kind: "signed_out" }} />;
  const routes = enrollment.value.requests;
  const guardian = links.value.requests;
  return (
    <div className="stack">
      <h1>My requests</h1>
      {routes.length === 0 && guardian.length === 0 && (
        <Card title="No requests yet">
          <p className="muted">Use a route code to join a route, or a guardian code to link a student.</p>
        </Card>
      )}
      {routes.map((r) => (
        <section key={r.enrollmentRequestId} className="card stack" style={{ gap: "var(--space-xs)" }}>
          <div className="row spread">
            <h2>{r.studentName}</h2>
            <span className="badge">{STATUS_TEXT[r.status]}</span>
          </div>
          <p className="muted small">
            {r.routeLabel} · {DIRECTION_LABEL[r.direction]} · {r.requestedStopLabel ?? "Stop chosen by the school"} · sent{" "}
            {dateTime(r.submittedAtMs)}
          </p>
          {r.status === "pending" && <p className="small">You can't see this bus until the school approves.</p>}
          {r.status === "approved" && (
            <a className="btn" href="#/">
              Track the bus
            </a>
          )}
          {r.decisionReason && <p className="small">School's reason: {r.decisionReason}</p>}
        </section>
      ))}
      {guardian.map((r) => (
        <section key={r.linkRequestId} className="card stack" style={{ gap: "var(--space-xs)" }}>
          <div className="row spread">
            <h2>{r.studentDisplayName ?? "Student link"}</h2>
            <span className="badge">{STATUS_TEXT[r.status]}</span>
          </div>
          <p className="muted small">Guardian link · sent {dateTime(r.submittedAtMs)}</p>
          {r.status === "pending" && <p className="small">The school checks its records before approving.</p>}
          {r.decisionReason && <p className="small">School's reason: {r.decisionReason}</p>}
        </section>
      ))}
    </div>
  );
}

// MARK: Link a student

export function LinkPage({ source, initialCode }: { source: FamilySource; initialCode: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [requestId] = useRequestId();
  const { busy, view, send } = useCommand(source);
  const submit = () => token && void send("guardianLinks:request", { requestId, token, guardianName: name });
  if (view?.kind === "sent") {
    return (
      <Card title="Request sent">
        <p>The school will check its records. You'll see the student here once they approve.</p>
        <a className="btn" href="#/requests">
          See my requests
        </a>
      </Card>
    );
  }
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <header className="stack" style={{ gap: "var(--space-xs)" }}>
        <h1>Link a student</h1>
        <p className="muted">Use the guardian code the school gave you. Each code works once, for one student.</p>
      </header>
      <section className="card stack">
        <CodeField purpose="guardian_link" label="Guardian code" initial={initialCode} onCode={setToken} />
        <label>
          Your name
          <input value={name} maxLength={MAX_STUDENT_NAME_LENGTH} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !token || !name.trim()}>
          {busy ? "Sending…" : "Send link request"}
        </button>
      </section>
      {view && <Problem view={view} onRetry={submit} />}
    </form>
  );
}

// MARK: Join as staff (docs/12 §1)

/**
 * Redeems a staff invitation for the signed-in person. Only a sign-in that
 * isn't linked to any account can join; the server checks the code.
 */
export function StaffInvitePage({ source }: { source: FamilySource }) {
  const [text, setText] = useState("");
  const { busy, view, send } = useCommand(source);
  const token = normalizeToken(text);
  const submit = () => token && void send("staffInvitations:redeem", { token });
  if (view?.kind === "sent") {
    return (
      <Card title="You're on the staff team">
        <p>Your staff account is ready.</p>
        <a className="btn btn-primary" href="#/staff/routes">
          Open the staff console
        </a>
      </Card>
    );
  }
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <header className="stack" style={{ gap: "var(--space-xs)" }}>
        <h1>Join as staff</h1>
        <p className="muted">Enter the staff invitation code a staff member gave you. It works once.</p>
      </header>
      <section className="card stack">
        <label>
          Staff invitation code
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="ABCD-EFGH-JKMN-PQRS-TVWX"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
          />
          {text.trim() && !token && <span className="error-text small">That doesn't look like a code. Check it and try again.</span>}
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !token}>
          {busy ? "Checking…" : "Join as staff"}
        </button>
      </section>
      {view && <Problem view={view} onRetry={submit} />}
    </form>
  );
}

// MARK: Check in

const time = (ms: number) => new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(ms);

export function CheckInPage({ source, initialCode }: { source: FamilySource; initialCode: string }) {
  const assignments = useFamilyQuery<MyAssignmentsResult>(source, "tracking:myAssignments", {});
  if (assignments.kind === "loading") return <Card title="Finding your trip…" busy />;
  if (assignments.kind === "failed") {
    return (
      <Card title="Couldn't find your trip">
        <p className="muted">Check your connection. If you can't check in, ask the driver to record you.</p>
      </Card>
    );
  }
  const own = assignments.value.status === "ready" ? assignments.value.assignments.filter((a) => a.relationship === "self") : [];
  if (own.length === 0) {
    return (
      <Card title="Check-in is for students">
        <p className="muted">
          Only a student's own approved account can check in. Guardians can't check someone in from home.
        </p>
      </Card>
    );
  }
  return (
    <div className="stack">
      <h1>Check in</h1>
      {own.map((a) => (
        <AssignmentCheckIn key={a.assignmentId} source={source} assignmentId={a.assignmentId} routeLabel={a.routeLabel} initialCode={initialCode} />
      ))}
    </div>
  );
}

function AssignmentCheckIn({
  source,
  assignmentId,
  routeLabel,
  initialCode,
}: {
  source: FamilySource;
  assignmentId: string;
  routeLabel: string;
  initialCode: string;
}) {
  const trip = useFamilyQuery<AssignmentCheckInResult>(source, "checkIns:forAssignment", { assignmentId });
  const [token, setToken] = useState<string | null>(null);
  // Refused scans are not stored, so one identity serves every attempt here;
  // a lost response is reconciled by resending it.
  const [requestId] = useRequestId();
  const { busy, view, send } = useCommand(source);

  if (trip.kind === "loading") return <Card title={`${routeLabel}: checking your trip…`} busy />;
  if (trip.kind === "failed" || trip.value.status !== "ready") {
    return (
      <Card title={routeLabel}>
        <p className="muted">Couldn't load this trip. Ask the driver to record you if you can't check in.</p>
      </Card>
    );
  }
  const { runId, checkIn } = trip.value;
  const recorded = view?.kind === "sent" ? view.checkIn : checkIn;
  const submit = (code: string | null) => runId && code && void send("checkIns:record", { requestId, token: code, runId });

  return (
    <section className="card stack">
      <h2>{routeLabel}</h2>
      {!runId ? (
        <p className="muted">Your bus isn't running a trip now, so there's nothing to check in to.</p>
      ) : recorded ? (
        <>
          <p className="status flush">
            <span className={`dot tone-${recorded.status === "boarded" ? "fresh" : "aging"}`} aria-hidden />
            <span>{checkInLine(recorded, time)}</span>
          </p>
          {view?.kind === "sent" && view.status === "already_recorded" && (
            <p className="muted small">You were already checked in on this trip. Nothing new was added.</p>
          )}
          <p className="muted small">This records your scan. It doesn't prove who got on the bus.</p>
        </>
      ) : (
        <>
          <p className="muted">Scan the check-in code on the bus screen, or type it.</p>
          <CameraScan
            onCode={(text) => {
              const code = parseScannedToken(text, "trip_check_in", [location.host]);
              if (code && !busy) submit(code);
            }}
          />
          <CodeField purpose="trip_check_in" label="Check-in code" initial={initialCode} onCode={setToken} />
          <button type="button" className="btn btn-primary" disabled={busy || !token} onClick={() => submit(token)}>
            {busy ? "Checking in…" : "Check in"}
          </button>
          {view && view.kind !== "sent" && <Problem view={view} onRetry={() => submit(token)} />}
          <p className="muted small">No phone or no connection? The driver can record you.</p>
        </>
      )}
    </section>
  );
}

/**
 * Reads one QR code with the browser's BarcodeDetector where it exists
 * (Chrome on Android). It stops after the first read, so repeated frames
 * can't send repeated check-ins.
 */
function CameraScan({ onCode }: { onCode: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const latest = useRef(onCode);
  latest.current = onCode;
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Detector = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } })
    .BarcodeDetector;
  useEffect(() => {
    if (!on || !Detector) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    const detector = new Detector({ formats: ["qr_code"] });
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        while (!stopped) {
          const found = await detector.detect(video.current);
          const first = found[0]?.rawValue;
          if (first) {
            stopped = true;
            setOn(false);
            latest.current(first);
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setError("The camera isn't available. Type the code instead.");
        setOn(false);
      }
    })();
    return () => {
      stopped = true;
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [on, Detector]);
  if (!Detector) return null;
  return (
    <div className="stack">
      {on ? (
        <>
          <video ref={video} muted playsInline className="card" style={{ width: "100%" }} />
          <button type="button" className="btn" onClick={() => setOn(false)}>
            Stop camera
          </button>
        </>
      ) : (
        <button type="button" className="btn" onClick={() => setOn(true)}>
          Scan with camera
        </button>
      )}
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

/** Shown on the tracking page when there is nothing approved yet. */
export function FamilyActions() {
  return (
    <nav className="switcher" aria-label="Family actions">
      <a className="chip" href="#/join">
        Join a route
      </a>
      <a className="chip" href="#/link">
        Link a student
      </a>
      <a className="chip" href="#/checkin">
        Check in
      </a>
      <a className="chip" href="#/requests">
        My requests
      </a>
    </nav>
  );
}

