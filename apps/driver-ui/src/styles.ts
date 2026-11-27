import { tokensCss } from "@itssb/ui";

/** Every color, size, and radius comes from @itssb/ui tokens. */
export const css = `${tokensCss()}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font-family: var(--font-family); font-size: var(--font-size-body); line-height: 1.35;
  background: var(--color-background); color: var(--color-text-primary);
  -webkit-user-select: none; user-select: none; overflow: hidden;
}
#app { height: 100vh; display: grid; grid-template-rows: auto 1fr; }
button { font: inherit; color: inherit; }
button:focus-visible { outline: var(--space-xs) solid var(--color-brand); outline-offset: var(--space-xxs); }

.bar { display: flex; align-items: center; gap: var(--space-md); padding: var(--space-md) var(--space-xl);
  background: var(--color-surface); border-bottom: var(--space-xxs) solid var(--color-border); }
.bar .who { flex: 1; min-width: 0; }
.bar .title { font-size: var(--font-size-headline); font-weight: var(--font-weight-bold); }
.bar .env { margin-left: var(--space-md); padding: var(--space-xxs) var(--space-sm); border-radius: var(--radius-sm);
  font-size: var(--font-size-caption); vertical-align: middle; background: var(--color-surface-muted); color: var(--color-text-primary);
  border: var(--space-xxs) solid var(--color-status-aging); }
.bar .sub { font-size: var(--font-size-caption); color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chips { display: flex; gap: var(--space-sm); }
.chip { display: flex; align-items: center; gap: var(--space-sm); min-height: var(--touch-driver);
  padding: 0 var(--space-md); border-radius: var(--radius-md); background: var(--color-surface-muted);
  border: var(--space-xxs) solid transparent; cursor: pointer; text-align: left; }
.chip .k { font-size: var(--font-size-caption); color: var(--color-text-secondary); display: block; }
.chip .v { font-size: var(--font-size-callout); font-weight: var(--font-weight-semibold); display: block; white-space: nowrap; }

.dot { width: var(--space-lg); height: var(--space-lg); border-radius: 50%; flex: none; border: var(--space-xxs) solid transparent; }
.lv-ok .dot, .dot.lv-ok { background: var(--color-status-fresh); }
.lv-warn .dot, .dot.lv-warn { background: var(--color-status-aging); }
.lv-problem .dot, .dot.lv-problem { background: var(--color-status-stale); }
.lv-unknown .dot, .dot.lv-unknown { background: transparent; border-color: var(--color-status-unknown); }
.lv-off .dot, .dot.lv-off { background: var(--color-status-unknown); }
.chip.lv-problem { border-color: var(--color-status-stale); }

.page { padding: var(--space-xl); display: grid; gap: var(--space-lg); align-content: start; overflow-y: auto; min-height: 0; }
h1 { font-size: var(--font-size-title); margin: 0; }
h2 { font-size: var(--font-size-headline); margin: 0; }
p { margin: 0; }
.muted { color: var(--color-text-secondary); }

.actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-lg); }
.action { min-height: calc(var(--touch-driver-primary) * 2); border-radius: var(--radius-card);
  border: var(--space-xxs) solid var(--color-border); background: var(--color-surface);
  padding: var(--space-lg) var(--space-xl); text-align: left; display: grid; gap: var(--space-xs); align-content: center; cursor: pointer; }
.action .name { font-size: var(--font-size-title); font-weight: var(--font-weight-bold); }
.action .why { font-size: var(--font-size-callout); color: var(--color-text-secondary); }
.action:enabled { background: var(--color-brand); color: var(--color-on-brand); border-color: var(--color-brand); }
.action:disabled { cursor: not-allowed; }
.action:disabled .name { color: var(--color-text-secondary); }

.row { display: flex; gap: var(--space-lg); align-items: center; }
.btn { min-height: var(--touch-driver); padding: 0 var(--space-xl); border-radius: var(--radius-md);
  border: var(--space-xxs) solid var(--color-border); background: var(--color-surface); cursor: pointer;
  font-weight: var(--font-weight-semibold); }
.btn.primary { background: var(--color-brand); color: var(--color-on-brand); border-color: var(--color-brand); }
.btn:disabled, .btn.primary:disabled { background: var(--color-surface-muted); color: var(--color-text-secondary);
  border-color: var(--color-border); cursor: not-allowed; }

.card { background: var(--color-surface); border-radius: var(--radius-card); padding: var(--space-lg) var(--space-xl);
  border: var(--space-xxs) solid var(--color-border); display: grid; gap: var(--space-sm); align-content: start; }
.checks { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-sm) var(--space-xl); }
.check { display: grid; grid-template-columns: auto 1fr; gap: var(--space-xs) var(--space-md); align-items: start; align-content: start; padding: var(--space-xs) 0; }
.check .dot { margin-top: var(--space-xs); }
.check .k { font-weight: var(--font-weight-semibold); }
.check .d { grid-column: 2; font-size: var(--font-size-callout); color: var(--color-text-secondary); }

.drive { display: grid; grid-template-columns: 2fr 1fr; gap: var(--space-lg); }
.big { font-size: var(--font-size-large-title); font-weight: var(--font-weight-bold); line-height: 1.15; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: var(--space-xs) var(--space-lg); font-size: var(--font-size-callout); }
.kv dt { color: var(--color-text-secondary); }
.kv dd { margin: 0; font-variant-numeric: tabular-nums; }
.banner { border-radius: var(--radius-md); padding: var(--space-md) var(--space-lg);
  background: var(--color-surface-muted); border-left: var(--space-sm) solid var(--color-status-aging); }
.banner.lv-problem { border-left-color: var(--color-status-stale); }

.split { display: grid; grid-template-columns: 1fr 1.4fr; gap: var(--space-lg); align-items: start; }
.choice { min-height: var(--touch-driver); padding: 0 var(--space-xl); border-radius: var(--radius-md); text-align: left;
  border: var(--space-xxs) solid var(--color-border); background: var(--color-surface-muted); font-weight: var(--font-weight-semibold); cursor: pointer; }
.choice.selected { border-color: var(--color-brand); background: var(--color-brand); color: var(--color-on-brand); }
.pin { font-size: var(--font-size-title); letter-spacing: var(--space-sm); text-align: center; min-height: var(--touch-driver);
  display: grid; place-items: center; border-radius: var(--radius-md); background: var(--color-surface-muted); }
.keypad { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-sm); }
.keyboard { display: grid; gap: var(--space-sm); }
.keys { display: flex; gap: var(--space-xs); }
.key { flex: 1; min-height: var(--touch-driver); border-radius: var(--radius-sm); border: var(--space-xxs) solid var(--color-border);
  background: var(--color-surface); font-size: var(--font-size-headline); font-weight: var(--font-weight-semibold); cursor: pointer; }
.key.wide { flex: 4; }
.field { min-height: var(--touch-driver); padding: var(--space-md) var(--space-lg); border-radius: var(--radius-md);
  border: var(--space-xxs) solid var(--color-brand); background: var(--color-surface-muted); font-size: var(--font-size-headline); }
.list { gap: var(--space-xs); }
.item { display: flex; align-items: center; justify-content: space-between; gap: var(--space-lg); min-height: var(--touch-driver);
  padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-md); background: var(--color-surface-muted);
  border: var(--space-xxs) solid transparent; text-align: left; cursor: pointer; }
button.item { flex-direction: column; align-items: flex-start; justify-content: center; gap: var(--space-xxs); }
.item .name { font-weight: var(--font-weight-semibold); }
.item.confirm { border-color: var(--color-status-stale); }
.item .row { gap: var(--space-sm); }
.pill { display: inline-flex; align-items: center; min-height: var(--touch-driver); padding: 0 var(--space-lg);
  border-radius: var(--radius-md); background: var(--color-surface-muted); color: var(--color-text-secondary); font-weight: var(--font-weight-semibold); }
.pill.lv-ok { background: var(--color-status-fresh); color: var(--color-surface); }
.map { padding: var(--space-sm); place-items: center; }
svg.route { width: 100%; height: auto; max-height: 420px; display: block; }
.one-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
svg.route .measured { fill: none; stroke: var(--color-text-primary); stroke-width: 4; stroke-linejoin: round; stroke-linecap: round; }
svg.route .gap { stroke: var(--color-status-aging); stroke-width: 3; stroke-dasharray: 8 8; }
svg.route .stop { fill: var(--color-brand); stroke: var(--color-on-brand); stroke-width: 2; }
svg.route .stop-n { fill: var(--color-on-brand); font-size: var(--font-size-caption); font-weight: var(--font-weight-bold); }
.stops { margin: 0; padding: 0; list-style: none; font-size: var(--font-size-callout); }
.check-line { font-size: var(--font-size-callout); }
.checks-1 { gap: var(--space-xs); }
.banner.lv-ok { border-left-color: var(--color-status-fresh); }
.banner.lv-warn { border-left-color: var(--color-status-aging); }

/* D15-D19: QR codes and the roster */
.qr-wrap { display: grid; grid-template-columns: auto 1fr; gap: var(--space-xl); align-items: start; }
.qr-box { width: calc(var(--touch-driver-primary) * 5.5); height: calc(var(--touch-driver-primary) * 5.5); }
/* Dark modules on a light field in both themes, so every scanner reads it. */
svg.qr { width: 100%; height: 100%; display: block; border-radius: var(--radius-md); }
svg.qr .qr-light { fill: var(--color-brand); }
svg.qr .qr-dark { fill: var(--color-on-brand); }
.typed { font-size: var(--font-size-title); font-weight: var(--font-weight-bold); letter-spacing: var(--space-xxs); font-variant-numeric: tabular-nums; }
.countdown { font-variant-numeric: tabular-nums; }
.qr-blank { min-height: calc(var(--touch-driver-primary) * 4); align-content: center; }
.student .who { display: grid; gap: var(--space-xxs); }
.student.gone .name { color: var(--color-text-secondary); }
.sync { font-size: var(--font-size-callout); font-weight: var(--font-weight-semibold); }
.sync.lv-ok { color: var(--color-status-fresh); }
.sync.lv-warn { color: var(--color-status-aging); }
.sync.lv-problem { color: var(--color-status-stale); }
.btn.danger { border-color: var(--color-status-stale); color: var(--color-status-stale); }
.card.confirm { border-color: var(--color-status-stale); }
button.field { display: grid; gap: var(--space-xxs); text-align: left; border-color: var(--color-border); cursor: pointer; font-size: var(--font-size-body); }
button.field.active { border-color: var(--color-brand); }
`;
