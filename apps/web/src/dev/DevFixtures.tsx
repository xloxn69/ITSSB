import { useMemo } from "react";
import { TrackPage } from "../family/TrackPage";
import { Shell } from "../Shell";
import { StaffApp } from "../staff/StaffApp";
import { TrackStore } from "../tracking/store";
import { FIXTURE_SCENARIOS, type FixtureScenario, fixtureSource } from "./fixtureSource";
import { STAFF_VARIANTS, type StaffVariant, staffFixtureSource } from "./staffFixtures";

/**
 * Development only: `?fixture=<scenario>` renders a family screen, and
 * `?fixture=staff…#/staff/<page>` a staff page, with fictional data.
 */
export default function DevFixtures() {
  const requested = new URLSearchParams(location.search).get("fixture") ?? "";
  const family = (FIXTURE_SCENARIOS as readonly string[]).includes(requested) ? (requested as FixtureScenario) : null;
  const staff = (STAFF_VARIANTS as readonly string[]).includes(requested) ? (requested as StaffVariant) : null;
  const store = useMemo(() => (family ? new TrackStore(fixtureSource(family)) : null), [family]);
  const staffSource = useMemo(() => (staff ? staffFixtureSource(staff) : null), [staff]);
  return (
    <Shell right={<span className="badge">Fictional data</span>}>
      {store && <TrackPage store={store} onSignIn={() => location.reload()} />}
      {staffSource && <StaffApp source={staffSource} />}
      {!store && !staffSource && (
        <nav className="card stack">
          <h1>Fixture screens</h1>
          {FIXTURE_SCENARIOS.map((s) => (
            <a key={s} href={`?fixture=${s}`}>
              {s}
            </a>
          ))}
          {STAFF_VARIANTS.map((s) => (
            <a key={s} href={`?fixture=${s}#/staff/routes`}>
              {s}
            </a>
          ))}
        </nav>
      )}
    </Shell>
  );
}
