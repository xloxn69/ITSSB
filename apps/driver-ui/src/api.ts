import type { DeviceSnapshot } from "./snapshot.js";

/**
 * Local API client. Same origin as the page (the device serves both), so no
 * CORS and no remote host. The browser never sees the device's cloud token.
 */

const TIMEOUT_MS = 3_000;

async function getJson(path: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(path, { cache: "no-store", credentials: "same-origin", signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeSnapshot(v: unknown): v is DeviceSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s["generatedAtMs"] === "number" &&
    typeof s["gps"] === "object" &&
    typeof s["network"] === "object" &&
    typeof s["backend"] === "object" &&
    typeof s["outbox"] === "object" &&
    "run" in s
  );
}

/**
 * The operating snapshot. Prefers `/api/status` (adds driver session, motion,
 * and capabilities) and falls back to `/health` on device software that only
 * has the health endpoint. Throws on anything that is not a snapshot.
 */
export async function fetchSnapshot(): Promise<DeviceSnapshot> {
  let res = await getJson("/api/status");
  if (res.status === 404) res = await getJson("/health");
  if (!res.ok) throw new Error(`device service answered HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!looksLikeSnapshot(body)) throw new Error("device service sent an unexpected answer");
  return body;
}
