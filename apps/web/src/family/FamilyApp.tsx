import { TOKEN_LINK_PATHS } from "@itssb/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { CheckInPage, FamilyActions, JoinPage, LinkPage, RequestsPage } from "./FamilyFlows";
import type { FamilySource } from "./familySource";

const PAGES = ["join", "link", "checkin", "requests"] as const;
type Page = (typeof PAGES)[number];

/**
 * A scanned link (`/join?token=…`, `/link?token=…`, `/checkin?token=…`)
 * becomes an in-app page, and the code is removed from the address bar and
 * history at once, so it isn't left in the URL or a screenshot of it.
 */
export function takeLinkedCode(loc: Pick<Location, "pathname" | "search" | "hash">): { page: Page; code: string } | null {
  const fromPath = (Object.entries(TOKEN_LINK_PATHS) as [string, string][]).find(([, path]) => path === loc.pathname);
  const page: Page | null = fromPath
    ? fromPath[0] === "route_enrollment"
      ? "join"
      : fromPath[0] === "guardian_link"
        ? "link"
        : "checkin"
    : null;
  if (!page) return null;
  const code = new URLSearchParams(loc.search).get("token") ?? "";
  return { page, code: code.slice(0, 64) };
}

function currentPage(): Page | null {
  const name = location.hash.replace(/^#\//, "").split(/[/?]/)[0] ?? "";
  return (PAGES as readonly string[]).includes(name) ? (name as Page) : null;
}

/** Family pages around tracking: join, link, check in, and request status. */
export function FamilyApp({ source, track }: { source: FamilySource; track: ReactNode }) {
  const [linked] = useState(() => {
    const taken = takeLinkedCode(location);
    if (taken) history.replaceState(null, "", `/#/${taken.page}`);
    return taken;
  });
  const [page, setPage] = useState<Page | null>(() => linked?.page ?? currentPage());
  useEffect(() => {
    const onChange = () => setPage(currentPage());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const code = linked && linked.page === page ? linked.code : "";
  return (
    <div className="stack">
      <FamilyActions />
      {page === null && track}
      {page === "join" && <JoinPage source={source} initialCode={code} />}
      {page === "link" && <LinkPage source={source} initialCode={code} />}
      {page === "checkin" && <CheckInPage source={source} initialCode={code} />}
      {page === "requests" && <RequestsPage source={source} />}
    </div>
  );
}
