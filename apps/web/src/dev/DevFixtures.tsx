import { useMemo, useState } from "react";
import { FamilyApp } from "../family/FamilyApp";
import { TrackPage } from "../family/TrackPage";
import { Shell } from "../Shell";
import { StaffApp } from "../staff/StaffApp";
import { TrackStore } from "../tracking/store";
import { FIXTURE_SCENARIOS, type FixtureScenario, fixtureSource } from "./fixtureSource";
import { FAMILY_FLOW_VARIANTS, type FamilyFlowVariant, familyFlowSource } from "./familyFlowFixtures";
import { STAFF_VARIANTS, type StaffVariant, staffFixtureSource } from "./staffFixtures";

/**
 * Development only: `?fixture=<scenario>` renders a family screen, and
 * `?fixture=staff…#/staff/<page>` a staff page, with fictional data.
 */
export default function DevFixtures() {
  // Read once: a scanned-link fixture rewrites the URL to drop the code.
  const [params] = useState(() => new URLSearchParams(location.search));
  const requested = params.get("fixture") ?? "";
  const flowVariant = params.get("v") ?? "default";
  const flows =
    requested === "family-flows" && (FAMILY_FLOW_VARIANTS as readonly string[]).includes(flowVariant)
      ? (flowVariant as FamilyFlowVariant)
      : null;
  const flowSource = useMemo(() => (flows ? familyFlowSource(flows) : null), [flows]);
  const flowStore = useMemo(() => (flows ? new TrackStore(fixtureSource("live")) : null), [flows]);
  const family = (FIXTURE_SCENARIOS as readonly string[]).includes(requested) ? (requested as FixtureScenario) : null;
  const staff = (STAFF_VARIANTS as readonly string[]).includes(requested) ? (requested as StaffVariant) : null;
  const store = useMemo(() => (family ? new TrackStore(fixtureSource(family)) : null), [family]);
  const staffSource = useMemo(() => (staff ? staffFixtureSource(staff) : null), [staff]);
  return (
    <Shell right={<span className="badge">Fictional data</span>}>
      {store && <TrackPage store={store} onSignIn={() => location.reload()} />}
      {staffSource && <StaffApp source={staffSource} />}
      {flowSource && flowStore && (
        <FamilyApp source={flowSource} track={<TrackPage store={flowStore} onSignIn={() => location.reload()} />} />
      )}
      {!store && !staffSource && !flowSource && (
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
