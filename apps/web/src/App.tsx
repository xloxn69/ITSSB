import { lazy, Suspense } from "react";
import { liveConfig } from "./live/config";
import { Shell } from "./Shell";

/**
 * Chooses the data source. Development fixtures exist only behind
 * `import.meta.env.DEV`, so a production build never shows a fictional
 * position. Otherwise the app signs in with Clerk and reads Convex.
 */
const DevFixtures = import.meta.env.DEV ? lazy(() => import("./dev/DevFixtures")) : null;
const LiveApp = lazy(() => import("./live/LiveApp").then((m) => ({ default: m.LiveApp })));

export function App() {
  if (DevFixtures && new URLSearchParams(location.search).has("fixture")) {
    return (
      <Suspense fallback={null}>
        <DevFixtures />
      </Suspense>
    );
  }
  const config = liveConfig();
  if (!config) return <NotConfigured />;
  return (
    <Suspense fallback={null}>
      <LiveApp config={config} />
    </Suspense>
  );
}

function NotConfigured() {
  return (
    <Shell>
      <section className="card message">
        <h1>ITSSB</h1>
        <p className="muted">Sign-in isn't set up for this site yet.</p>
      </section>
    </Shell>
  );
}
