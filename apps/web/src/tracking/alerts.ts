/**
 * Alerts inbox and the approaching-alert preference for one assignment
 * (docs/08 §9.1). The web app cannot receive push; the inbox is where an
 * Android family sees server-created alerts. Framework-free and tested.
 */
import { alertsSnapshot, preferenceSnapshot } from "./mapping";
import type { AlertItem, Preference } from "./model";
import type { TrackingSource, Unsubscribe } from "./store";

export type AlertsState =
  | { kind: "unavailable" }
  | { kind: "loading" }
  | { kind: "ready"; alerts: AlertItem[]; preference: Preference | null; saving: boolean; saveFailed: boolean }
  | { kind: "failed" };

export class AlertsStore {
  state: AlertsState;
  private listeners = new Set<() => void>();
  private unsubs: Unsubscribe[] = [];
  private alerts: AlertItem[] | null = null;
  private preference: Preference | null = null;
  private saving = false;
  private saveFailed = false;

  constructor(private readonly source: TrackingSource) {
    this.state = source.alerts ? { kind: "loading" } : { kind: "unavailable" };
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Watches the inbox and this assignment's preference. */
  start(assignmentId: string): void {
    this.stop();
    if (!this.source.alerts) return;
    this.set({ kind: "loading" });
    this.unsubs.push(
      this.source.alerts(
        (raw) => {
          try {
            const snap = alertsSnapshot(raw);
            this.alerts = snap.kind === "ready" ? snap.alerts.filter((a) => a.assignmentId === assignmentId) : [];
            this.render();
          } catch {
            this.set({ kind: "failed" });
          }
        },
        () => this.set({ kind: "failed" }),
      ),
    );
    if (this.source.preference) {
      this.unsubs.push(
        this.source.preference(
          assignmentId,
          (raw) => {
            try {
              const snap = preferenceSnapshot(raw);
              this.preference = snap.kind === "ready" ? snap.preference : null;
              this.render();
            } catch {
              this.set({ kind: "failed" });
            }
          },
          () => this.set({ kind: "failed" }),
        ),
      );
    }
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.alerts = null;
    this.preference = null;
    this.saving = false;
    this.saveFailed = false;
  }

  /** Saves a new choice. The shown value changes only when the server confirms it. */
  async save(approachingEnabled: boolean, approachingMinutes: number): Promise<void> {
    const current = this.preference;
    if (!current || !this.source.setPreference || this.saving) return;
    this.saving = true;
    this.saveFailed = false;
    this.render();
    try {
      const raw = await this.source.setPreference({
        requestId: crypto.randomUUID(),
        assignmentId: current.assignmentId,
        approachingEnabled,
        approachingMinutes,
      });
      const snap = preferenceSnapshot(raw);
      if (snap.kind === "ready") this.preference = snap.preference;
      else this.saveFailed = true;
    } catch {
      this.saveFailed = true;
    } finally {
      this.saving = false;
      this.render();
    }
  }

  private render(): void {
    if (this.alerts === null) return;
    this.set({
      kind: "ready",
      alerts: this.alerts,
      preference: this.preference,
      saving: this.saving,
      saveFailed: this.saveFailed,
    });
  }

  private set(state: AlertsState): void {
    this.state = { ...state };
    for (const l of this.listeners) l();
  }
}
