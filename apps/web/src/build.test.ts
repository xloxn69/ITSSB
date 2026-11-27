import { describe, expect, it } from "vitest";
import { buildInfo, environmentLabel } from "./build";

describe("build identity (docs/14 §1-2)", () => {
  it("reads the stamped release, commit and environment", () => {
    expect(
      buildInfo({
        VITE_ITSSB_RELEASE: "2026.11.27-abc1234",
        VITE_ITSSB_REVISION: "abc1234def",
        VITE_ITSSB_ENVIRONMENT: "staging",
      }),
    ).toEqual({ release: "2026.11.27-abc1234", revision: "abc1234def", environment: "staging" });
  });

  it("treats a missing or unknown environment as development, never production", () => {
    expect(buildInfo({}).environment).toBe("development");
    expect(buildInfo({ VITE_ITSSB_ENVIRONMENT: "prod" }).environment).toBe("development");
  });

  it("keeps an unstamped build unidentified rather than guessing", () => {
    expect(buildInfo({ VITE_ITSSB_ENVIRONMENT: "production", VITE_ITSSB_RELEASE: " " })).toEqual({
      release: null,
      revision: null,
      environment: "production",
    });
  });

  it("labels every non-production build and hides the label in production", () => {
    expect(environmentLabel("development")).toBe("Development");
    expect(environmentLabel("staging")).toBe("Staging");
    expect(environmentLabel("production")).toBeNull();
  });
});
