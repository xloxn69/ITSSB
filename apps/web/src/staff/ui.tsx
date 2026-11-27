import { type ReactNode, useEffect, useState } from "react";
import {
  type MutationOutcome,
  mutationOutcome,
  type QueryState,
  queryState,
  type StaffActionName,
  type StaffMutationName,
  type StaffQueryName,
  type StaffSource,
} from "./source";

/** Shared staff page pieces: one loading/denied/failed rendering, one mutation flow. */

export type Ready<T> = Extract<T, { status: "ready" }>;

export interface Received<T> {
  state: QueryState<T>;
  receivedAtWallMs: number;
}

export function useStaffQuery<T>(source: StaffSource, name: StaffQueryName, args: Record<string, string> = {}): Received<T> {
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
export function Loaded<T>({ state, children }: { state: QueryState<T>; children: (value: T) => ReactNode }) {
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

export function Notice({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="card message">
      <h2>{title}</h2>
      <p className="muted">{detail}</p>
    </section>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="muted">{text}</p>;
}

export function useMutation(source: StaffSource) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<MutationOutcome | null>(null);
  const [last, setLast] = useState<unknown>(null);
  async function settle(call: () => Promise<unknown>, done: string) {
    setBusy(true);
    setOutcome(null);
    setLast(null);
    try {
      const raw = await call();
      setLast(raw);
      setOutcome(mutationOutcome(raw, done));
    } catch {
      // The outcome is unknown, not failed: the server may have applied it.
      setOutcome({ kind: "failed", message: "No answer from the server. Reload to see whether it was applied." });
    } finally {
      setBusy(false);
    }
  }
  const run = (name: StaffMutationName, args: Record<string, string>, done: string) =>
    settle(() => source.mutate(name, args), done);
  const act = (name: StaffActionName, args: Record<string, string | number>, done: string) =>
    settle(() => source.act(name, args), done);
  return { busy, outcome, last, run, act };
}

export function Outcome({ outcome }: { outcome: MutationOutcome | null }) {
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

export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

