import { type ClerkResult, type EmailCodeClerk, SignInFlow } from "../live/signInFlow";

/** Development only: sign-in screen states for `?fixture=sign-in&v=<variant>`. */
export const SIGN_IN_VARIANTS = ["email", "code", "error"] as const;
export type SignInVariant = (typeof SIGN_IN_VARIANTS)[number];

const FIXTURE_CODE = "424242";
const ok: ClerkResult = { error: null };
const wrongCode: ClerkResult = { error: { errors: [{ code: "form_code_incorrect" }] } };

/** A fictional Clerk that accepts one code; it never reaches the network. */
function fixtureClerk(): EmailCodeClerk {
  const resource = {
    status: "needs_first_factor" as string | null,
    async finalize() {
      return ok;
    },
  };
  return {
    signIn: () => ({
      ...resource,
      create: async () => ok,
      emailCode: {
        sendCode: async () => ok,
        verifyCode: async ({ code }) => (code === FIXTURE_CODE ? ok : wrongCode),
      },
    }),
    signUp: () => ({
      ...resource,
      create: async () => ok,
      verifications: {
        sendEmailCode: async () => ok,
        verifyEmailCode: async ({ code }) => (code === FIXTURE_CODE ? ok : wrongCode),
      },
    }),
  };
}

/** A flow already moved to the requested state, with a fictional address. */
export function signInFixtureFlow(variant: SignInVariant): SignInFlow {
  const flow = new SignInFlow(fixtureClerk());
  if (variant !== "email") {
    void flow.submitEmail("student@example.com").then(() => {
      if (variant === "error") void flow.submitCode("000000");
    });
  }
  return flow;
}
