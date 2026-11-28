import type { TrackContext } from "../tracking/store";
import { RouteDiagram } from "./RouteDiagram";
import { walkingDirectionsUrl } from "./routeLinks";

/**
 * My route and stop (docs/06 I13/I14 on the web): the approved route and the
 * assigned stop, read-only, with no bus. The live bus is in the trip above.
 */
export function RouteDetails({ context }: { context: TrackContext }) {
  const route = context.route;
  if (!route) return null;
  const stop = route.assignedStop;
  return (
    <details className="card stack">
      <summary>
        <strong>My route and stop</strong>
      </summary>
      <RouteDiagram route={route} position={null} dimBus={false} busLabel="" />
      <dl className="stack" style={{ gap: "var(--space-xs)", margin: 0 }}>
        <div>
          <dt className="muted small">Student</dt>
          <dd>{context.assignment.studentDisplayName}</dd>
        </div>
        <div>
          <dt className="muted small">Route</dt>
          <dd>{route.routeLabel}</dd>
        </div>
        <div>
          <dt className="muted small">Stop</dt>
          <dd>{stop.label}</dd>
        </div>
      </dl>
      <p className="muted small">The line is the route your school approved, not driving directions.</p>
      <p>
        <a className="btn" href={walkingDirectionsUrl(stop)} target="_blank" rel="noopener noreferrer">
          Walking directions in Google Maps
        </a>
      </p>
      <p className="muted small">Google Maps plans the walk. ITSSB doesn't check the path or how long it takes.</p>
    </details>
  );
}
