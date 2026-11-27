import type { ReactNode } from "react";

/** Top bar and page frame shared by every screen. */
export function Shell({ right, children }: { right?: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <span className="brand">
          <i className="brand-mark" aria-hidden />
          ITSSB
        </span>
        <div className="row">{right}</div>
      </header>
      <main className="shell">{children}</main>
    </>
  );
}
