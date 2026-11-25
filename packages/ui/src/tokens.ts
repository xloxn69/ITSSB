/**
 * Web design tokens. Mirrors apps/ios/Packages/ITSSBDesignSystem so the
 * driver screen, staff web, and iOS app share one visual language.
 * Change a value in both places.
 */

export const colors = {
  light: {
    background: "#F7F7F5",
    surface: "#FFFFFF",
    surfaceMuted: "#EEEEEA",
    border: "#DEDED8",
    textPrimary: "#16181B",
    textSecondary: "#5C6168",
    brand: "#F2B300",
    onBrand: "#16181B",
    statusFresh: "#1F8A4C",
    statusAging: "#B26A00",
    statusStale: "#B3261E",
    statusUnknown: "#6B7078",
  },
  dark: {
    background: "#101113",
    surface: "#1A1C1F",
    surfaceMuted: "#24272B",
    border: "#33373C",
    textPrimary: "#F2F3F5",
    textSecondary: "#A3A9B1",
    brand: "#FFC51A",
    onBrand: "#16181B",
    statusFresh: "#3DBE72",
    statusAging: "#F0A23B",
    statusStale: "#F2766B",
    statusUnknown: "#8E949C",
  },
} as const;

export type ColorToken = keyof typeof colors.light;

/** 4-point spacing scale, in px. */
export const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 8, md: 12, card: 16, sheet: 24 } as const;

/** Minimum touch target. The driver screen uses a larger one for gloved hands. */
export const touchTarget = { standard: 44, driver: 64 } as const;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const colorVars = (theme: Record<string, string>) =>
  Object.entries(theme)
    .map(([k, v]) => `  --color-${kebab(k)}: ${v};`)
    .join("\n");

/** CSS custom properties for both themes, e.g. `--color-text-primary`. */
export function tokensCss(): string {
  const scale = Object.entries(spacing)
    .map(([k, v]) => `  --space-${k}: ${v}px;`)
    .join("\n");
  const radii = Object.entries(radius)
    .map(([k, v]) => `  --radius-${kebab(k)}: ${v}px;`)
    .join("\n");
  return [
    `:root {\n${colorVars(colors.light)}\n${scale}\n${radii}\n}`,
    `@media (prefers-color-scheme: dark) {\n:root {\n${colorVars(colors.dark)}\n}\n}`,
  ].join("\n");
}
