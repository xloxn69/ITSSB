import { useMemo } from "react";
import { TrackPage } from "../family/TrackPage";
import { Shell } from "../Shell";
import { TrackStore } from "../tracking/store";
import { FIXTURE_SCENARIOS, type FixtureScenario, fixtureSource } from "./fixtureSource";

/** Development only: `?fixture=<scenario>` renders a screen with fictional data. */
export default function DevFixtures() {
  const requested = new URLSearchParams(location.search).get("fixture") ?? "";
  const scenario = (FIXTURE_SCENARIOS as readonly string[]).includes(requested)
    ? (requested as FixtureScenario)
    : null;
  const store = useMemo(() => (scenario ? new TrackStore(fixtureSource(scenario)) : null), [scenario]);
  return (
    <Shell right={<span className="badge">Fictional data</span>}>
        {store ? (
          <TrackPage store={store} onSignIn={() => location.reload()} />
        ) : (
          <nav className="card stack">
            <h1>Fixture screens</h1>
            {FIXTURE_SCENARIOS.map((s) => (
              <a key={s} href={`?fixture=${s}`}>
                {s}
              </a>
            ))}
          </nav>
        )}
    </Shell>
  );
}
