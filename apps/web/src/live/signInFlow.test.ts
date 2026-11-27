import { describe, expect, it } from "vitest";
import {
  CONVEX_ACCEPT_WAIT_MS,
  type ClerkResult,
  type EmailCodeClerk,
  problemFor,
  RESEND_COOLDOWN_MS,
  SignInFlow,
  sessionGate,
  type SignInLike,
  type SignUpLike,
} from "./signInFlow";

const apiError = (code: string) => ({ errors: [{ code }] });
const ok: ClerkResult = { error: null };

/**
 * A fake Clerk instance that models state, not calls: which addresses have
 * accounts, the one code currently valid (a new one on every send), and who
 * is signed in. Fictional addresses only.
 */
function fakeClerk(existing: string[]) {
  const accounts = new Set(existing);
  let nextCode = 111111;
  const world = {
    sentCode: null as string | null,
    signedInAs: null as string | null,
  };
  const send = () => {
    nextCode += 1;
    world.sentCode = String(nextCode);
  };
  // Clerk replaces its resources as an attempt moves on; the fake does too.
  let signIn = { email: null as string | null, status: null as string | null };
  let signUp = { email: null as string | null, status: null as string | null };
  const clerk: EmailCodeClerk = {
    signIn: (): SignInLike => ({
      status: signIn.status,
      async create({ identifier }) {
        if (!accounts.has(identifier)) return { error: apiError("form_identifier_not_found") };
        signIn = { email: identifier, status: "needs_first_factor" };
        return ok;
      },
      emailCode: {
        async sendCode() {
          if (!signIn.email) return { error: apiError("form_param_nil") };
          send();
          return ok;
        },
        async verifyCode({ code }) {
          if (code !== world.sentCode) return { error: apiError("form_code_incorrect") };
          signIn = { ...signIn, status: "complete" };
          return ok;
        },
      },
      async finalize() {
        world.signedInAs = signIn.status === "complete" ? signIn.email : null;
        return ok;
      },
    }),
    signUp: (): SignUpLike => ({
      status: signUp.status,
      async create({ emailAddress }) {
        signUp = { email: emailAddress, status: "missing_requirements" };
        return ok;
      },
      verifications: {
        async sendEmailCode() {
          if (!signUp.email) return { error: apiError("form_param_nil") };
          send();
          return ok;
        },
        async verifyEmailCode({ code }) {
          if (code !== world.sentCode) return { error: apiError("form_code_incorrect") };
          accounts.add(signUp.email ?? "");
          signUp = { ...signUp, status: "complete" };
          return ok;
        },
      },
      async finalize() {
        world.signedInAs = signUp.status === "complete" ? signUp.email : null;
        return ok;
      },
    }),
  };
  return { clerk, world };
}

function setup(existing: string[] = ["student@example.com"]) {
  let nowMs = 1_800_000_000_000;
  const { clerk, world } = fakeClerk(existing);
  const flow = new SignInFlow(clerk, () => nowMs);
  return {
    clerk,
    flow,
    world,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("email-code sign-in (same logic as iOS ClerkSDKBackend)", () => {
  it("signs in a known address with the emailed code", async () => {
    const { flow, world } = setup();
    await flow.submitEmail("  student@example.com ");
    expect(flow.getState().step).toEqual({ kind: "code", email: "student@example.com", via: "signIn" });
    await flow.submitCode(world.sentCode ?? "");
    expect(flow.getState()).toMatchObject({ signedIn: true, problem: null, working: false });
    expect(world.signedInAs).toBe("student@example.com");
  });

  it("creates the identity for an address Clerk has never seen, which then signs in normally", async () => {
    const { clerk, flow, world } = setup([]);
    await flow.submitEmail("new.guardian@example.com");
    expect(flow.getState().step).toEqual({ kind: "code", email: "new.guardian@example.com", via: "signUp" });
    await flow.submitCode(world.sentCode ?? "");
    expect(world.signedInAs).toBe("new.guardian@example.com");

    const again = new SignInFlow(clerk);
    await again.submitEmail("new.guardian@example.com");
    expect(again.getState().step).toMatchObject({ via: "signIn" });
  });

  it("keeps the person on the code step with an explanation when the code is wrong", async () => {
    const { flow, world } = setup();
    await flow.submitEmail("student@example.com");
    await flow.submitCode("000000");
    expect(flow.getState()).toMatchObject({ step: { kind: "code" }, problem: "invalidCode", signedIn: false });
    expect(world.signedInAs).toBeNull();
    await flow.submitCode(world.sentCode ?? "");
    expect(world.signedInAs).toBe("student@example.com");
  });

  it("allows a new code only after the wait, and the new code replaces the old one", async () => {
    const { flow, world, advance } = setup();
    await flow.submitEmail("student@example.com");
    const first = world.sentCode;
    await flow.resend();
    expect(world.sentCode).toBe(first);
    expect(flow.canResend()).toBe(false);

    advance(RESEND_COOLDOWN_MS);
    await flow.resend();
    expect(world.sentCode).not.toBe(first);
    expect(flow.canResend()).toBe(false);

    await flow.submitCode(first ?? "");
    expect(flow.getState().problem).toBe("invalidCode");
    await flow.submitCode(world.sentCode ?? "");
    expect(world.signedInAs).toBe("student@example.com");
  });

  it("rejects a malformed email without calling Clerk", async () => {
    const { flow, world } = setup();
    await flow.submitEmail("not-an-email");
    expect(flow.getState()).toMatchObject({ step: { kind: "email" }, problem: "invalidEmail" });
    expect(world.sentCode).toBeNull();
  });

  it("ignores a late reply after the person chose a different email", async () => {
    let release: (() => void) | undefined;
    const { clerk } = fakeClerk(["student@example.com"]);
    const slow: EmailCodeClerk = {
      signUp: clerk.signUp,
      signIn: () => {
        const real = clerk.signIn();
        return {
          ...real,
          create: async (p) => {
            await new Promise<void>((r) => {
              release = r;
            });
            return real.create(p);
          },
        };
      },
    };
    const flow = new SignInFlow(slow);
    const pending = flow.submitEmail("student@example.com");
    expect(flow.getState().working).toBe(true);
    flow.changeEmail();
    release?.();
    await pending;
    expect(flow.getState()).toMatchObject({ step: { kind: "email" }, working: false });
  });
});

describe("Clerk error mapping (same table as iOS)", () => {
  it("reads the code from a Clerk API response error", () => {
    expect(problemFor(apiError("form_code_incorrect"))).toBe("invalidCode");
    expect(problemFor(apiError("verification_expired"))).toBe("codeExpired");
    expect(problemFor(apiError("too_many_requests"))).toBe("tooManyAttempts");
    expect(problemFor({ code: "network_error" })).toBe("network");
    expect(problemFor(new TypeError("Failed to fetch"))).toBe("network");
    expect(problemFor(apiError("something_new"))).toBe("failed");
  });
});

describe("session gate after Clerk signs in", () => {
  const base = { convexLoading: false, convexAuthenticated: false, clerkSignedIn: true };
  it("keeps checking while Convex has not answered yet, instead of calling it refused", () => {
    expect(sessionGate({ ...base, waitingMs: 0 })).toBe("checking");
    expect(sessionGate({ ...base, waitingMs: CONVEX_ACCEPT_WAIT_MS - 1 })).toBe("checking");
  });
  it("says refused only after the wait, and signed in as soon as Convex accepts", () => {
    expect(sessionGate({ ...base, waitingMs: CONVEX_ACCEPT_WAIT_MS })).toBe("refused");
    expect(sessionGate({ ...base, convexAuthenticated: true, waitingMs: 0 })).toBe("signedIn");
  });
  it("shows sign-in when nobody is signed in, and checking while Convex loads", () => {
    expect(sessionGate({ ...base, clerkSignedIn: false, waitingMs: 0 })).toBe("signIn");
    expect(sessionGate({ ...base, convexLoading: true, waitingMs: 0 })).toBe("checking");
  });
});
