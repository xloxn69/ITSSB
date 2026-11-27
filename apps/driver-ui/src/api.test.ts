import { describe, expect, it } from "vitest";
import { ApiError, noAnswer, RequestIds } from "./api.js";

describe("request ids", () => {
  it("a retry of the same action reuses its id until the device answers", () => {
    let n = 0;
    const ids = new RequestIds(() => `id-${++n}`);
    const first = ids.for("markStop");
    expect(ids.for("markStop")).toBe(first); // double tap / timeout retry
    expect(ids.for("finish")).not.toBe(first);
    ids.answered("markStop");
    expect(ids.for("markStop")).not.toBe(first); // a new stop is a new action
  });

  it("a timeout keeps the id; a refusal or acceptance releases it", () => {
    expect(noAnswer(new Error("aborted"))).toBe(true);
    expect(noAnswer(new ApiError(503, "X", "x"))).toBe(true);
    expect(noAnswer(new ApiError(409, "NOT_PARKED", "x"))).toBe(false);
  });
});
