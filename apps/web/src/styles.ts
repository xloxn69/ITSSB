import { tokensCss } from "@itssb/ui";

/**
 * App styles. Every color, spacing and radius is a `packages/ui` token
 * (`--color-*`, `--space-*`, `--radius-*`); dark mode follows the system.
 */
const appCss = `
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: var(--color-background); color: var(--color-text-primary); }
#app { min-height: 100vh; }
a { color: inherit; }
button { font: inherit; }
.shell { max-width: 72rem; margin: 0 auto; padding: var(--space-lg); }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-md);
  padding: var(--space-md) var(--space-lg); border-bottom: 1px solid var(--color-border);
  background: var(--color-surface); }
.topbar nav { display: flex; gap: var(--space-sm); flex-wrap: wrap; }
.brand { font-weight: 700; letter-spacing: 0.02em; }
.brand-mark { display: inline-block; width: var(--space-md); height: var(--space-md); border-radius: var(--radius-sm);
  background: var(--color-brand); margin-right: var(--space-sm); vertical-align: -1px; }
.card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-card);
  padding: var(--space-lg); }
.stack { display: flex; flex-direction: column; gap: var(--space-lg); }
.muted { color: var(--color-text-secondary); }
.small { font-size: 0.875rem; }
h1, h2, h3 { margin: 0; line-height: 1.25; }
h1 { font-size: 1.5rem; }
h2 { font-size: 1.125rem; }
p { margin: 0; }
.btn { min-height: 44px; padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-md);
  border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text-primary);
  cursor: pointer; }
.btn-primary { background: var(--color-brand); color: var(--color-on-brand); border-color: var(--color-brand);
  font-weight: 600; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid var(--color-brand); outline-offset: 2px; }
.message { text-align: center; padding: var(--space-xxl) var(--space-lg); display: flex; flex-direction: column;
  gap: var(--space-md); align-items: center; }
.message-icon { width: var(--space-xxl); height: var(--space-xxl); border-radius: 50%;
  background: var(--color-surface-muted); display: grid; place-items: center; color: var(--color-text-secondary); }
.status { display: flex; gap: var(--space-md); align-items: flex-start; }
.dot { flex: none; width: var(--space-md); height: var(--space-md); border-radius: 50%; margin-top: var(--space-xs); }
.tone-fresh { background: var(--color-status-fresh); }
.tone-aging { background: var(--color-status-aging); }
.tone-stale { background: var(--color-status-stale); }
.tone-unknown { background: var(--color-status-unknown); }
.text-tone-fresh { color: var(--color-status-fresh); }
.text-tone-aging { color: var(--color-status-aging); }
.text-tone-stale { color: var(--color-status-stale); }
.text-tone-unknown { color: var(--color-status-unknown); }
.age { font-variant-numeric: tabular-nums; }
.track-grid { display: grid; gap: var(--space-lg); grid-template-columns: 1fr; }
@media (min-width: 52rem) { .track-grid { grid-template-columns: 3fr 2fr; } }
.route-map { width: 100%; height: auto; display: block; background: var(--color-surface-muted);
  border-radius: var(--radius-md); }
.route-line { fill: none; stroke: var(--color-text-secondary); stroke-width: 4; stroke-linecap: round;
  stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.stop-pin { fill: var(--color-surface); stroke: var(--color-text-primary); stroke-width: 3; vector-effect: non-scaling-stroke; }
.stop-number { fill: var(--color-text-primary); font-size: 22px; font-weight: 700; }
.bus-pin { fill: var(--color-brand); stroke: var(--color-on-brand); stroke-width: 2; vector-effect: non-scaling-stroke; }
.bus-pin.dim { fill: var(--color-status-unknown); opacity: 0.6; }
.facts { display: grid; grid-template-columns: auto 1fr; gap: var(--space-xs) var(--space-lg); margin: 0; }
.facts dt { color: var(--color-text-secondary); }
.facts dd { margin: 0; }
.switcher { display: flex; gap: var(--space-sm); flex-wrap: wrap; }
.chip { min-height: 44px; padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-sheet);
  border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text-primary); cursor: pointer; }
a.chip { display: inline-flex; align-items: center; text-decoration: none; }
.chip[aria-current="page"],
.chip[aria-pressed="true"] { background: var(--color-text-primary); color: var(--color-surface); border-color: var(--color-text-primary); }
.legend { display: flex; gap: var(--space-lg); flex-wrap: wrap; font-size: 0.875rem; color: var(--color-text-secondary); }
.legend span { display: inline-flex; gap: var(--space-xs); align-items: center; }
.swatch { display: inline-block; width: var(--space-md); height: var(--space-md); border-radius: 50%; }
.swatch-bus { background: var(--color-brand); }
.swatch-bus.dim { background: var(--color-status-unknown); opacity: 0.6; }
.swatch-stop { background: var(--color-surface); border: 2px solid var(--color-text-primary); }
.swatch-line { width: var(--space-lg); height: var(--space-xs); border-radius: var(--radius-sm); background: var(--color-text-secondary); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--color-border); vertical-align: top; }
th { color: var(--color-text-secondary); font-weight: 600; font-size: 0.875rem; }
.badge { display: inline-block; padding: var(--space-xxs) var(--space-sm); border-radius: var(--radius-sm);
  background: var(--color-surface-muted); font-size: 0.8125rem; font-weight: 600; }
.row { display: flex; gap: var(--space-md); align-items: center; flex-wrap: wrap; }
.spread { justify-content: space-between; }
label { display: flex; flex-direction: column; gap: var(--space-xs); }
input, select, textarea { font: inherit; min-height: 44px; padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface);
  color: var(--color-text-primary); }
.error-text { color: var(--color-status-stale); }
@media (max-width: 40rem) {
  .responsive-table thead { display: none; }
  .responsive-table tr { display: block; border-bottom: 1px solid var(--color-border); padding: var(--space-sm) 0; }
  .responsive-table td { display: flex; gap: var(--space-md); border: none; padding: var(--space-xs) 0; }
  .responsive-table td::before { content: attr(data-label); color: var(--color-text-secondary); min-width: 7rem; }
}
`;

export function installStyles(): void {
  const style = document.createElement("style");
  style.textContent = `${tokensCss()}\n${appCss}`;
  document.head.append(style);
}
