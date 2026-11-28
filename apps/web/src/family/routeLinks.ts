import type { Coordinate } from "../tracking/model";

/**
 * A walking-directions handoff to Google Maps for the assigned stop (docs/06
 * I14, web parity: the family web app is for Android). The person opens it;
 * the app never plans the walk or promises its time.
 */
export function walkingDirectionsUrl(stop: Coordinate): string {
  const destination = `${stop.latitude.toFixed(6)},${stop.longitude.toFixed(6)}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=walking`;
}
