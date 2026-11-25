import { tokensCss, touchTarget } from "@itssb/ui";

/**
 * First driver screen: a truthful status page (docs/15 "next session" step 5).
 * GPS, internet, and cloud authorization are shown separately; one green icon
 * must never stand in for all three. The full 24-screen flow is docs/05.
 */

type Check = "ok" | "problem" | "unknown";
interface Health {
  gps: Check;
  internet: Check;
  cloud: Check;
}

const style = document.createElement("style");
style.textContent = `${tokensCss()}
  body { margin: 0; font: 20px/1.4 system-ui, sans-serif;
         background: var(--color-background); color: var(--color-text-primary); }
  main { padding: var(--space-xl); display: grid; gap: var(--space-lg); }
  .row { display: flex; align-items: center; gap: var(--space-md); min-height: ${touchTarget.driver}px;
         padding: 0 var(--space-lg); border-radius: var(--radius-card); background: var(--color-surface); }
  .dot { width: 16px; height: 16px; border-radius: 50%; }
  .ok { background: var(--color-status-fresh); }
  .problem { background: var(--color-status-stale); }
  .unknown { background: var(--color-status-unknown); }`;
document.head.append(style);

const LABELS: Record<keyof Health, string> = { gps: "GPS fix", internet: "Internet", cloud: "Cloud access" };
const WORDS: Record<Check, string> = { ok: "OK", problem: "Problem", unknown: "Checking…" };

function render(health: Health): void {
  const app = document.querySelector<HTMLElement>("#app");
  if (!app) return;
  app.replaceChildren(
    ...(Object.keys(LABELS) as (keyof Health)[]).map((key) => {
      const row = document.createElement("div");
      row.className = "row";
      const dot = document.createElement("span");
      dot.className = `dot ${health[key]}`;
      const text = document.createElement("span");
      text.textContent = `${LABELS[key]}: ${WORDS[health[key]]}`;
      row.append(dot, text);
      return row;
    }),
  );
}

async function poll(): Promise<void> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    render(res.ok ? ((await res.json()) as Health) : { gps: "unknown", internet: "unknown", cloud: "unknown" });
  } catch {
    // The local device service itself is unreachable.
    render({ gps: "unknown", internet: "unknown", cloud: "unknown" });
  }
}

render({ gps: "unknown", internet: "unknown", cloud: "unknown" });
void poll();
setInterval(() => void poll(), 2000);
