import { APPROACHING_MINUTES_MAX, APPROACHING_MINUTES_MIN } from "@itssb/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AlertsStore } from "../tracking/alerts";
import { alertCurrency, alertCurrencyText, type TripNow } from "../tracking/alertDetail";
import { alertRow, capturedTime } from "../tracking/presentation";
import type { TrackingSource } from "../tracking/store";

const MINUTE_CHOICES = [2, 3, 5, 7, 10, 15].filter((m) => m >= APPROACHING_MINUTES_MIN && m <= APPROACHING_MINUTES_MAX);

/**
 * Approaching-alert preference and the in-app alerts inbox (docs/08 §9.1).
 * The web app gets no push; this list is where web families see alerts.
 */
export function AlertsPanel({ source, assignmentId, trip }: { source: TrackingSource; assignmentId: string; trip: TripNow }) {
  const store = useMemo(() => new AlertsStore(source), [source]);
  const state = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.state,
  );
  useEffect(() => {
    store.start(assignmentId);
    return () => store.stop();
  }, [store, assignmentId]);

  if (state.kind === "unavailable") return null;
  return (
    <section className="card stack" aria-labelledby="alerts-heading">
      <h2 id="alerts-heading">Alerts</h2>
      {state.kind === "loading" && <p className="muted" aria-busy>Loading alerts…</p>}
      {state.kind === "failed" && <p className="muted">Alerts couldn't be loaded. They will show again when the connection returns.</p>}
      {state.kind === "ready" && (
        <>
          {state.preference && (
            <div className="stack" style={{ gap: "var(--space-sm)" }}>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={state.preference.approachingEnabled}
                  disabled={state.saving}
                  onChange={(e) => store.save(e.target.checked, state.preference!.approachingMinutes)}
                />
                <span>Alert me when the bus is about to reach my stop</span>
              </label>
              <label>
                <span className="muted small">How far ahead</span>
                <select
                  value={state.preference.approachingMinutes}
                  disabled={state.saving || !state.preference.approachingEnabled}
                  onChange={(e) => store.save(true, Number(e.target.value))}
                >
                  {[...new Set([...MINUTE_CHOICES, state.preference.approachingMinutes])]
                    .toSorted((a, b) => a - b)
                    .map((m) => (
                      <option key={m} value={m}>
                        About {m} minutes
                      </option>
                    ))}
                </select>
              </label>
              <p className="muted small">
                Alerts appear here once per trip. On the web they are not sent as phone notifications.
              </p>
              {state.saveFailed && <p className="error-text small">Couldn't save. Your previous choice is still in effect.</p>}
            </div>
          )}
          {state.alerts.length === 0 ? (
            <p className="muted">No alerts yet.</p>
          ) : (
            <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {state.alerts.map((a) => {
                const row = alertRow(a);
                // I21 alert details: whether this alert still describes the trip.
                const currency = alertCurrencyText(alertCurrency(a, trip), (ms) => capturedTime(ms));
                return (
                  <li key={a.alertId}>
                    <details className="stack" style={{ gap: "var(--space-xs)" }}>
                      <summary>
                        <strong>{row.title}</strong>
                        <span className="muted small"> {row.detail}</span>
                      </summary>
                      <p>
                        <strong>{currency.title}</strong>
                        <br />
                        <span className="muted small">{currency.detail}</span>
                      </p>
                      <p className="muted small">
                        Stop: {a.stopLabel}. Estimated arrival {capturedTime(a.predictedArrivalAtMs)}, estimate made at{" "}
                        {capturedTime(a.predictionGeneratedAtMs)}, alert sent {new Date(a.createdAtMs).toLocaleString()}. Sent by
                        ITSSB from the bus's reported location; arrival times are estimates and can change.
                      </p>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
