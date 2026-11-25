import { tokensCss } from "@itssb/ui";

// Placeholder until Phase 6/9 (docs/15). The staff console and family web are
// specified in docs/12_ADMIN_AND_ANDROID_WEB.md.
const style = document.createElement("style");
style.textContent = `${tokensCss()}
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif;
         background: var(--color-background); color: var(--color-text-primary); }
  main { max-width: 40rem; margin: 0 auto; padding: var(--space-xl) var(--space-lg); }`;
document.head.append(style);

const app = document.querySelector<HTMLElement>("#app");
if (app) {
  const h1 = document.createElement("h1");
  h1.textContent = "ITSSB";
  const p = document.createElement("p");
  p.textContent = "Staff and family web is not built yet.";
  app.append(h1, p);
}
