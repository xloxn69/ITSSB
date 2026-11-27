/**
 * Owns the selected assignment, its subscriptions, and the screen state
 * (docs/06 §6, mirrored from the iOS `TrackViewModel`). Framework-free so the
 * state rules are tested without a browser.
 */
import { type Instant, queryClock, readInstant, type ServerClock, verifiedClock } from "./clock";
import { assignmentsSnapshot, MappingError, routeSnapshot, runSnapshot } from "./mapping";
import type { AssignmentSummary, RouteGeometry, RunSnapshot, TrackedRun } from "./model";

export type Unsubscribe = () => void;

/** The backend no longer accepts the session (the auth SDK's typed failure). */
export class SessionExpiredError extends Error {
  constructor() {
    super("Session expired");
    this.name = "SessionExpiredError";
  }
}

/**
 * Raw `tracking:*` results. Values are unvalidated wire data; the store
 * maps them. Implemented by the Convex client and by development fixtures.
 */
export interface TrackingSource {
  assignments(onValue: (raw: unknown) => void, onError: (error: unknown) => void): Unsubscribe;
  run(assignmentId: string, onValue: (raw: unknown) => void, onError: (error: unknown) => void): Unsubscribe;
  route(assignmentId: string, onValue: (raw: unknown) => void, onError: (error: unknown) => void): Unsubscribe;
  /** `tracking:serverTime`: uncached `serverNowMs`. Rejects when unavailable. */
  serverTime(): Promise<number>;
}

export interface TrackContext {
  assignment: AssignmentSummary;
  /** Null until `tracking:myRoute` answers, or if it answered for another route version. */
  route: RouteGeometry | null;
}

/**
 * Explicit screen states. Fresh vs. stale is not stored: it depends on the
 * clock, so the view derives it every second from `run` and `clock`.
 */
export type TrackState =
  | { kind: "loading" }
  | { kind: "tracking"; context: TrackContext; run: TrackedRun; clock: ServerClock }
  | { kind: "no_active_run"; context: TrackContext }
  /** No approved assignment, or access was removed. Protected data is cleared. */
  | { kind: "access_unavailable" }
  /** The backend no longer accepts the session. Protected data is cleared. */
  | { kind: "session_expired" }
  /** Recoverable failure. Never presented as "no trip". */
  | { kind: "failed"; message: string };

export const TRANSPORT_FAILURE = "Couldn't reach the tracking service. Check your connection and try again.";
export const INVALID_DATA_FAILURE = "The tracking service sent data this app couldn't verify, so it isn't shown.";

export function stateForError(error: unknown): TrackState {
  if (error instanceof SessionExpiredError) return { kind: "session_expired" };
  if (error instanceof MappingError) return { kind: "failed", message: INVALID_DATA_FAILURE };
  return { kind: "failed", message: TRANSPORT_FAILURE };
}

export class TrackStore {
  state: TrackState = { kind: "loading" };
  assignments: AssignmentSummary[] = [];
  selectedAssignmentId: string | null = null;

  private listeners = new Set<() => void>();
  private generation = 0;
  private unsubAssignments: Unsubscribe | null = null;
  private unsubSelection: Unsubscribe[] = [];
  private route: RouteGeometry | null = null;
  private snapshot: { value: RunSnapshot; receivedAtWallMs: number } | null = null;
  private verified: ServerClock | null = null;
  private clockGeneration = 0;

  constructor(
    private readonly source: TrackingSource,
    private readonly now: () => Instant = readInstant,
  ) {}

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts (or restarts) the assignment subscription and verifies server time. */
  start(): void {
    this.stop();
    this.set({ kind: "loading" });
    this.verifyServerTime();
    this.unsubAssignments = this.source.assignments(
      (raw) => this.applyAssignments(raw),
      (error) => this.fail(error),
    );
  }

  /** Cancels every subscription and drops protected data. */
  stop(): void {
    this.unsubAssignments?.();
    this.unsubAssignments = null;
    this.clearSelection();
    this.assignments = [];
  }

  retry(): void {
    this.start();
  }

  /** Switches to another approved assignment (docs/06 §8). */
  select(assignmentId: string): void {
    if (assignmentId === this.selectedAssignmentId) return;
    if (!this.assignments.some((a) => a.assignmentId === assignmentId)) return;
    this.beginSelection(assignmentId);
  }

  /**
   * Drops verified time and measures it again. Call when the page becomes
   * visible again: a sleeping device can pause the monotonic clock.
   */
  reverifyServerTime(): void {
    this.verified = null;
    this.render();
    this.verifyServerTime();
  }

  private verifyServerTime(): void {
    const attempt = ++this.clockGeneration;
    const sent = this.now();
    this.source.serverTime().then(
      (serverNowMs) => {
        if (attempt !== this.clockGeneration) return;
        // An unusable sample leaves the clock unverified: never fresh.
        this.verified = verifiedClock(sent, this.now(), serverNowMs);
        this.render();
      },
      () => {
        // Unavailable: stay unverified, so nothing is shown as fresh.
      },
    );
  }

  private applyAssignments(raw: unknown): void {
    let snapshot: ReturnType<typeof assignmentsSnapshot>;
    try {
      snapshot = assignmentsSnapshot(raw);
    } catch (error) {
      this.fail(error);
      return;
    }
    if (snapshot.kind === "access_unavailable") {
      this.assignments = [];
      this.clearSelection();
      this.set(snapshot.reason === "unauthenticated" ? { kind: "session_expired" } : { kind: "access_unavailable" });
      return;
    }
    this.assignments = snapshot.assignments;
    const first = snapshot.assignments[0];
    if (!first) {
      this.clearSelection();
      this.set({ kind: "access_unavailable" });
    } else if (this.selectedAssignmentId && this.assignments.some((a) => a.assignmentId === this.selectedAssignmentId)) {
      this.render();
    } else {
      this.beginSelection(first.assignmentId);
    }
  }

  /** Cancel the old subscriptions, start a new generation, clear protected details, enter loading. */
  private beginSelection(assignmentId: string): void {
    this.clearSelection();
    const current = this.generation;
    this.selectedAssignmentId = assignmentId;
    this.set({ kind: "loading" });
    const guard =
      <T>(fn: (value: T) => void) =>
      (value: T) => {
        if (current === this.generation) fn(value);
      };
    this.unsubSelection = [
      this.source.route(
        assignmentId,
        guard((raw) => this.applyRoute(assignmentId, raw)),
        guard((error) => this.fail(error)),
      ),
      this.source.run(
        assignmentId,
        guard((raw) => this.applyRun(raw)),
        guard((error) => this.fail(error)),
      ),
    ];
  }

  private applyRoute(assignmentId: string, raw: unknown): void {
    try {
      const snapshot = routeSnapshot(raw);
      if (snapshot.kind === "ready") {
        this.route = snapshot.route.assignmentId === assignmentId ? snapshot.route : null;
      } else {
        this.snapshot = { value: snapshot, receivedAtWallMs: this.now().wallMs };
      }
      this.render();
    } catch (error) {
      this.fail(error);
    }
  }

  private applyRun(raw: unknown): void {
    try {
      this.snapshot = { value: runSnapshot(raw), receivedAtWallMs: this.now().wallMs };
      this.render();
    } catch (error) {
      this.fail(error);
    }
  }

  private render(): void {
    const selected = this.selectedAssignmentId;
    const assignment = this.assignments.find((a) => a.assignmentId === selected);
    if (!selected || !assignment) return;
    const snap = this.snapshot;
    if (!snap) {
      this.set({ kind: "loading" });
      return;
    }
    const value = snap.value;
    switch (value.kind) {
      case "ready": {
        if (value.assignmentId !== selected) return;
        const clock = this.verified ?? queryClock(value.serverNowMs, snap.receivedAtWallMs);
        this.set({ kind: "tracking", context: this.context(assignment, value.routeVersionId), run: value.run, clock });
        return;
      }
      case "no_active_run":
        if (value.assignmentId !== selected) return;
        this.set({ kind: "no_active_run", context: this.context(assignment, value.routeVersionId) });
        return;
      case "access_unavailable":
        this.clearSelection();
        this.set(value.reason === "unauthenticated" ? { kind: "session_expired" } : { kind: "access_unavailable" });
        return;
    }
  }

  /** Only geometry for the run's own route version is drawn. */
  private context(assignment: AssignmentSummary, routeVersionId: string): TrackContext {
    return { assignment, route: this.route?.routeVersionId === routeVersionId ? this.route : null };
  }

  private fail(error: unknown): void {
    this.clearSelection();
    this.set(stateForError(error));
  }

  private clearSelection(): void {
    for (const unsub of this.unsubSelection) unsub();
    this.unsubSelection = [];
    this.generation += 1;
    this.selectedAssignmentId = null;
    this.route = null;
    this.snapshot = null;
  }

  private set(state: TrackState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
