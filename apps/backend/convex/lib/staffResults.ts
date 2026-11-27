import { SCHEMA_VERSION, type StaffOpResult } from "@itssb/contracts";
import { v } from "convex/values";
import { accessUnavailable } from "./staff";

/** Return validator for a `StaffOpResult` with these refusal codes. */
export function staffActionResult<const C extends readonly [string, string, ...string[]]>(codes: C) {
  const [a, b, ...rest] = codes;
  return v.union(
    v.object({ schemaVersion: v.literal(SCHEMA_VERSION), status: v.literal("ok"), serverNowMs: v.number() }),
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("refused"),
      serverNowMs: v.number(),
      code: v.union(v.literal(a), v.literal(b), ...rest.map((c) => v.literal(c))),
      message: v.string(),
    }),
    accessUnavailable,
  );
}

export const okResult = <C extends string>(): StaffOpResult<C> => ({
  schemaVersion: SCHEMA_VERSION,
  status: "ok",
  serverNowMs: Date.now(),
});

export const refusedResult = <C extends string>(code: C, message: string): StaffOpResult<C> => ({
  schemaVersion: SCHEMA_VERSION,
  status: "refused",
  serverNowMs: Date.now(),
  code,
  message,
});

/** Trimmed text of 1..max characters, or null. */
export function boundedText(raw: string | undefined, max: number): string | null {
  const text = raw?.trim() ?? "";
  return text && text.length <= max ? text : null;
}
