import { lazy, Suspense } from "react";

/**
 * Chooses the data source. Development fixtures exist only behind
 * `import.meta.env.DEV`, so a production build never shows a fictional
 * position; production uses the signed-in Convex client.
 */
const DevFixtures = import.meta.env.DEV ? lazy(() => import("./dev/DevFixtures")) : null;

export function App() {
  if (DevFixtures && new URLSearchParams(location.search).has("fixture")) {
    return (
      <Suspense fallback={null}>
        <DevFixtures />
      </Suspense>
    );
  }
  return <NotConfigured />;
}

function NotConfigured() {
  return (
    <main className="shell">
      <section className="card message">
        <h1>ITSSB</h1>
        <p className="muted">Sign-in isn't set up for this site yet.</p>
      </section>
    </main>
  );
}
