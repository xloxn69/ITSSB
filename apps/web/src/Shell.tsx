import type { ReactNode } from "react";
import { buildInfo, environmentLabel } from "./build";

const build = buildInfo();
const envLabel = environmentLabel(build.environment);
const buildTitle = `Release ${build.release ?? "unstamped"}, commit ${build.revision?.slice(0, 7) ?? "unknown"}`;

/** Top bar and page frame shared by every screen. */
export function Shell({ right, children }: { right?: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <span className="brand">
          <i className="brand-mark" aria-hidden />
          ITSSB
          {envLabel ? (
            <span className="badge env-badge" title={buildTitle}>
              {envLabel}
            </span>
          ) : null}
        </span>
        <div className="row">{right}</div>
      </header>
      <main className="shell">{children}</main>
    </>
  );
}
