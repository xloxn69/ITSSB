/**
 * Email one-time-code sign-in (docs/06 I02-I03, docs/17 §8), with no Clerk
 * prebuilt screens. Same logic as the iOS app (ClerkSDKBackend.swift): start a
 * sign-in for the address; when Clerk has never seen it
 * (`form_identifier_not_found`), create a sign-up for it instead, so staff can
 * link the new identity later. Signing in proves identity only; what a person
 * may see is decided on the server.
 *
 * This module has no React or DOM code. `SignInLike` and `SignUpLike` are the
 * parts of Clerk's headless `useSignIn()` / `useSignUp()` resources it uses, so
 * tests drive it with a fake instead of the network.
 */

/** Result of every Clerk headless call: an error, or null on success. */
export interface ClerkResult {
  error: unknown;
}

export interface SignInLike {
  readonly status: string | null;
  create(params: { identifier: string }): Promise<ClerkResult>;
  emailCode: {
    sendCode(): Promise<ClerkResult>;
    verifyCode(params: { code: string }): Promise<ClerkResult>;
  };
  finalize(): Promise<ClerkResult>;
}

export interface SignUpLike {
  readonly status: string | null;
  create(params: { emailAddress: string }): Promise<ClerkResult>;
  verifications: {
    sendEmailCode(): Promise<ClerkResult>;
    verifyEmailCode(params: { code: string }): Promise<ClerkResult>;
  };
  finalize(): Promise<ClerkResult>;
}

/**
 * Reads the current resources at call time: Clerk replaces them as an attempt
 * moves on, so a reference held across an `await` could be out of date.
 */
export interface EmailCodeClerk {
  signIn(): SignInLike;
  signUp(): SignUpLike;
}

export type SignInProblem =
  | "invalidEmail"
  | "invalidCode"
  | "codeExpired"
  | "tooManyAttempts"
  | "network"
  | "needsMoreInfo"
  | "failed";

export type SignInStep = { kind: "email" } | { kind: "code"; email: string; via: "signIn" | "signUp" };

export interface SignInState {
  step: SignInStep;
  working: boolean;
  problem: SignInProblem | null;
  /** When "Send a new code" is allowed again (epoch ms); null when allowed now. */
  resendAvailableAtMs: number | null;
  /** True once Clerk has an active session; Convex then verifies its token. */
  signedIn: boolean;
}

/** Same wait as iOS (SessionStore.resendCooldown). */
export const RESEND_COOLDOWN_MS = 30_000;

/** Same copy as iOS (SessionStore), so both clients explain a failure alike. */
export function problemMessage(problem: SignInProblem): string {
  switch (problem) {
    case "invalidEmail":
      return "Enter a valid email address.";
    case "invalidCode":
      return "That code isn't right. Check the email and try again.";
    case "codeExpired":
      return "That code has expired. Send a new one.";
    case "tooManyAttempts":
      return "Too many tries. Wait a minute, then try again.";
    case "network":
      return "Couldn't reach the sign-in service. Check your connection and try again.";
    case "needsMoreInfo":
      return "This account needs more setup before it can sign in here. Contact your school.";
    case "failed":
      return "Sign-in didn't finish. Try again.";
  }
}

/** The Clerk API error code, from a response error's first entry or the error itself. */
export function clerkErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const first = (error as { errors?: { code?: unknown }[] }).errors?.[0]?.code;
  if (typeof first === "string") return first;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Clerk API error codes the sign-in screen explains (same table as iOS). */
export function problemFor(error: unknown): SignInProblem {
  const code = clerkErrorCode(error);
  switch (code) {
    case "form_identifier_not_found":
    case "form_param_format_invalid":
    case "form_param_nil":
      return "invalidEmail";
    case "form_code_incorrect":
    case "verification_failed":
      return "invalidCode";
    case "verification_expired":
      return "codeExpired";
    case "too_many_requests":
    case "rate_limit_exceeded":
    case "too_many_attempts":
      return "tooManyAttempts";
    case "network_error":
    case "clerk_offline":
      return "network";
    default:
      return error instanceof TypeError ? "network" : "failed";
  }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Thrown inside the flow to stop a step with a problem to show. */
class Stop extends Error {
  constructor(readonly problem: SignInProblem) {
    super(problem);
  }
}

function check(result: ClerkResult): void {
  if (result.error) throw new Stop(problemFor(result.error));
}

export class SignInFlow {
  private state: SignInState = {
    step: { kind: "email" },
    working: false,
    problem: null,
    resendAvailableAtMs: null,
    signedIn: false,
  };
  private readonly listeners = new Set<() => void>();
  /** Bumped by "Use a different email", so a late reply never moves the screen back. */
  private generation = 0;

  constructor(
    private readonly clerk: EmailCodeClerk,
    private readonly now: () => number = Date.now,
  ) {}

  getState = (): SignInState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  canResend(atMs: number = this.now()): boolean {
    return this.state.resendAvailableAtMs === null || atMs >= this.state.resendAvailableAtMs;
  }

  async submitEmail(raw: string): Promise<void> {
    const email = raw.trim();
    if (!EMAIL.test(email)) return this.set({ problem: "invalidEmail" });
    await this.run(async () => {
      const started = await this.clerk.signIn().create({ identifier: email });
      let via: "signIn" | "signUp" = "signIn";
      if (started.error && clerkErrorCode(started.error) === "form_identifier_not_found") {
        // First sign-in for this address: create the identity so staff can link it later.
        via = "signUp";
        check(await this.clerk.signUp().create({ emailAddress: email }));
        check(await this.clerk.signUp().verifications.sendEmailCode());
      } else {
        check(started);
        check(await this.clerk.signIn().emailCode.sendCode());
      }
      return {
        step: { kind: "code", email, via },
        resendAvailableAtMs: this.now() + RESEND_COOLDOWN_MS,
      };
    });
  }

  async submitCode(raw: string): Promise<void> {
    const step = this.state.step;
    if (step.kind !== "code") return;
    const code = raw.replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) return this.set({ problem: "invalidCode" });
    await this.run(async () => {
      if (step.via === "signIn") {
        check(await this.clerk.signIn().emailCode.verifyCode({ code }));
        if (this.clerk.signIn().status !== "complete") throw new Stop("needsMoreInfo");
        check(await this.clerk.signIn().finalize());
      } else {
        check(await this.clerk.signUp().verifications.verifyEmailCode({ code }));
        if (this.clerk.signUp().status !== "complete") throw new Stop("needsMoreInfo");
        check(await this.clerk.signUp().finalize());
      }
      return { signedIn: true };
    });
  }

  async resend(): Promise<void> {
    const step = this.state.step;
    if (step.kind !== "code" || !this.canResend()) return;
    await this.run(async () => {
      check(
        step.via === "signIn"
          ? await this.clerk.signIn().emailCode.sendCode()
          : await this.clerk.signUp().verifications.sendEmailCode(),
      );
      return { resendAvailableAtMs: this.now() + RESEND_COOLDOWN_MS };
    });
  }

  changeEmail(): void {
    this.generation += 1;
    this.set({ step: { kind: "email" }, working: false, problem: null, resendAvailableAtMs: null });
  }

  /** Runs one step: shows working, then its result or problem, unless the person moved on. */
  private async run(step: () => Promise<Partial<SignInState>>): Promise<void> {
    if (this.state.working) return;
    const generation = this.generation;
    this.set({ working: true, problem: null });
    let next: Partial<SignInState>;
    try {
      next = await step();
    } catch (error) {
      next = { problem: error instanceof Stop ? error.problem : problemFor(error) };
    }
    if (generation !== this.generation) return;
    this.set({ ...next, working: false });
  }

  private set(patch: Partial<SignInState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
