import { useEffect, useState, useSyncExternalStore } from "react";
import { readInstant } from "../tracking/clock";
import {
  capturedTime,
  dimsMarker,
  etaView,
  livePresentation,
  showsMarker,
  statusCopy,
  stopProgressText,
  whileDisconnected,
} from "../tracking/presentation";
import { connectionNotice, type TrackContext, type TrackStore } from "../tracking/store";
import type { TrackedRun } from "../tracking/model";
import type { ServerClock } from "../tracking/clock";
import { AlertsPanel } from "./AlertsPanel";
import { RouteDiagram } from "./RouteDiagram";

/** Re-renders every second so the age advances without a new update (docs/06 §9). */
function useTick(): ReturnType<typeof readInstant> {
  const [now, setNow] = useState(readInstant);
  useEffect(() => {
    const id = setInterval(() => setNow(readInstant()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useStore(store: TrackStore) {
  // The store replaces `state` on every change, so its identity is the snapshot.
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.state,
  );
}

/** Family tracking (docs/06 I09/I10/I12/I25–I28 on the web). */
export function TrackPage({ store, onSignIn }: { store: TrackStore; onSignIn: () => void }) {
  const state = useStore(store);
  const notice = connectionNotice(state, store.connectionLost);

  useEffect(() => {
    store.start();
    // A sleeping device can pause the monotonic clock: re-measure server time
    // whenever the page is shown again (docs/08 §8.1).
    const reverify = () => {
      if (document.visibilityState === "visible") store.reverifyServerTime();
    };
    document.addEventListener("visibilitychange", reverify);
    window.addEventListener("pageshow", reverify);
    return () => {
      document.removeEventListener("visibilitychange", reverify);
      window.removeEventListener("pageshow", reverify);
      store.stop();
    };
  }, [store]);

  return (
    <div className="stack">
      {store.assignments.length > 1 && (
        <div className="switcher" role="group" aria-label="Choose a student">
          {store.assignments.map((a) => (
            <button
              key={a.assignmentId}
              type="button"
              className="chip"
              aria-pressed={a.assignmentId === store.selectedAssignmentId}
              onClick={() => store.select(a.assignmentId)}
            >
              {a.studentDisplayName}
            </button>
          ))}
        </div>
      )}
      {notice === "banner" && (
        <p className="card status" role="status">
          <span className="dot tone-stale" aria-hidden />
          <span>Connection lost. Reconnecting… The bus position below keeps aging until updates return.</span>
        </p>
      )}
      {(() => {
        if (notice === "replace") {
          return (
            <Message
              title="Can't confirm your trip right now"
              detail="The connection to the tracking service was lost. Reconnecting… Your trip status will show again once it's back."
              busy
            />
          );
        }
        switch (state.kind) {
          case "loading":
            return <Message title="Finding your bus…" detail="Loading your approved trip." busy />;
          case "no_active_run":
            return (
              <>
                <ContextHeader context={state.context} />
                <Message title="No trip right now" detail="Your bus isn't running a route at the moment." />
              </>
            );
          case "access_unavailable":
            return (
              <Message
                title="Tracking not available"
                detail="Your account isn't linked to an approved route. Your school can approve it."
              />
            );
          case "session_expired":
            return (
              <Message title="Signed out" detail="Your session ended. Sign in again to see your bus.">
                <button type="button" className="btn btn-primary" onClick={onSignIn}>
                  Sign in
                </button>
              </Message>
            );
          case "failed":
            return (
              <Message title="Something went wrong" detail={state.message}>
                <button type="button" className="btn" onClick={() => store.retry()}>
                  Try again
                </button>
              </Message>
            );
          case "tracking":
            return (
              <Tracking
                context={state.context}
                run={state.run}
                clock={state.clock}
                connectionLost={store.connectionLost}
              />
            );
        }
      })()}
      {(state.kind === "tracking" || state.kind === "no_active_run") && (
        <AlertsPanel source={store.source} assignmentId={state.context.assignment.assignmentId} />
      )}
    </div>
  );
}

function ContextHeader({ context }: { context: TrackContext }) {
  const a = context.assignment;
  return (
    <header className="stack" style={{ gap: "var(--space-xs)" }}>
      <h1>{a.studentDisplayName}</h1>
      <p className="muted">
        {a.routeLabel} · Stop: {a.stopLabel}
      </p>
    </header>
  );
}

function Tracking({
  context,
  run,
  clock,
  connectionLost,
}: {
  context: TrackContext;
  run: TrackedRun;
  clock: ServerClock;
  connectionLost: boolean;
}) {
  const now = useTick();
  const presentation = whileDisconnected(livePresentation(run, clock, now), connectionLost);
  const copy = statusCopy(presentation, run, clock, now);
  const marker = showsMarker(presentation) ? run.position : null;
  // While disconnected, no estimate is shown: it can't be confirmed current.
  const eta = connectionLost ? null : etaView(run, clock, now);
  const progress = stopProgressText(run);
  return (
    <>
      <ContextHeader context={context} />
      <div className="track-grid">
        <div className="card">
          {context.route ? (
            <RouteDiagram route={context.route} position={marker} dimBus={dimsMarker(presentation)} busLabel={run.busLabel} />
          ) : (
            <p className="muted">The route drawing isn't available. The trip details are shown here.</p>
          )}
        </div>
        <div className="stack">
          <section className="card status" aria-live="polite" aria-atomic="true">
            <span className={`dot tone-${copy.tone}`} aria-hidden />
            <div className="stack" style={{ gap: "var(--space-xs)" }}>
              <h2>{copy.title}</h2>
              <p>{copy.detail}</p>
              {copy.age && <p className="muted age">{copy.age}</p>}
              {progress && <p>{progress}</p>}
            </div>
          </section>
          {eta && (
            <section className="card stack" style={{ gap: "var(--space-xs)" }} aria-live="polite">
              <p className="muted small">Estimated arrival at your stop</p>
              <h2>{eta.headline}</h2>
              <p>
                Around <span className="age">{eta.arrivalText}</span>
              </p>
              <p className="muted small age">{eta.madeText}. Estimates can change.</p>
            </section>
          )}
          <section className="card">
            <dl className="facts">
              <dt>Bus</dt>
              <dd>{run.busLabel}</dd>
              <dt>Your stop</dt>
              <dd>{run.assignedStop.label}</dd>
              {marker && (
                <>
                  <dt>Reported at</dt>
                  <dd className="age">{capturedTime(marker.capturedAtMs)}</dd>
                </>
              )}
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}

function Message({
  title,
  detail,
  busy,
  children,
}: {
  title: string;
  detail: string;
  busy?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section className="card message" aria-busy={busy}>
      <div className="message-icon" aria-hidden>
        {busy ? "…" : "i"}
      </div>
      <h2>{title}</h2>
      <p className="muted">{detail}</p>
      {children}
    </section>
  );
}
