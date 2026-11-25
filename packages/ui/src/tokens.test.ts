import { describe, expect, it } from "vitest";
import { colors, spacing, tokensCss } from "./tokens.js";

describe("tokens", () => {
  it("defines the same color names for light and dark", () => {
    expect(Object.keys(colors.dark).toSorted()).toEqual(Object.keys(colors.light).toSorted());
  });

  it("keeps spacing on the 4-point grid (except hairline xxs)", () => {
    const offGrid = Object.entries(spacing).filter(([name, px]) => name !== "xxs" && px % 4 !== 0);
    expect(offGrid).toEqual([]);
  });

  it("emits kebab-case CSS variables for both themes", () => {
    const css = tokensCss();
    expect(css).toContain("--color-text-primary: #16181B;");
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain("--space-lg: 16px;");
  });
});
