/**
 * Which build this is (docs/14 §1-2), from public build variables set by the
 * release runbook (docs/runbooks/release.md):
 *
 * - `VITE_ITSSB_RELEASE`: release name, `<UTC date>-<7-char commit>`.
 * - `VITE_ITSSB_REVISION`: full git commit.
 * - `VITE_ITSSB_ENVIRONMENT`: `development`, `staging` or `production`.
 *
 * An unstamped build reports null rather than a guessed version. A missing or
 * unknown environment counts as development, so a build is unlabeled only when
 * it was deliberately built for production.
 */
export type Environment = "development" | "staging" | "production";

export interface BuildInfo {
  release: string | null;
  revision: string | null;
  environment: Environment;
}

const ENVIRONMENTS: readonly Environment[] = ["development", "staging", "production"];

const text = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);

export function buildInfo(env: Record<string, unknown> = import.meta.env): BuildInfo {
  const raw = text(env.VITE_ITSSB_ENVIRONMENT);
  return {
    release: text(env.VITE_ITSSB_RELEASE),
    revision: text(env.VITE_ITSSB_REVISION),
    environment: ENVIRONMENTS.find((e) => e === raw) ?? "development",
  };
}

/** Visible label for a non-production build; production shows none. */
export function environmentLabel(environment: Environment): string | null {
  if (environment === "production") return null;
  return environment === "staging" ? "Staging" : "Development";
}
