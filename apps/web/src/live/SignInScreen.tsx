import { type FormEvent, useEffect, useState, useSyncExternalStore } from "react";
import { problemMessage, type SignInFlow } from "./signInFlow";

/**
 * Our own email-code sign-in screen (docs/06 I02-I03). No Clerk prebuilt
 * component: `SignInFlow` drives Clerk's headless API, and every style here is
 * a `packages/ui` token through the app stylesheet.
 */
export function SignInScreen({ flow }: { flow: SignInFlow }) {
  const state = useSyncExternalStore(flow.subscribe, flow.getState);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const step = state.step;

  const submitEmail = (event: FormEvent) => {
    event.preventDefault();
    void flow.submitEmail(email);
  };
  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    void flow.submitCode(code);
  };
  const changeEmail = () => {
    setCode("");
    flow.changeEmail();
  };

  return (
    <div className="sign-in stack">
      <div className="stack-sm">
        <h1>Sign in</h1>
        <p className="muted">Bus locations are shown only to students and guardians your school has approved.</p>
      </div>
      <section className="card stack" aria-busy={state.working}>
        {step.kind === "email" ? (
          <form className="stack" onSubmit={submitEmail} noValidate>
            <label>
              Email address
              <input
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={state.working}
                aria-invalid={state.problem === "invalidEmail"}
                aria-describedby={state.problem ? "sign-in-problem" : undefined}
                autoFocus
              />
            </label>
            <button type="submit" className="btn btn-primary" disabled={state.working}>
              {state.working ? "Please wait…" : "Email me a code"}
            </button>
            {/* Clerk's bot check for a first sign-in (sign-up) renders its widget here, inside
                our screen. Without this slot Clerk opens its own modal instead. */}
            <div id="clerk-captcha" />
          </form>
        ) : (
          <form className="stack" onSubmit={submitCode} noValidate>
            <p>
              Enter the code we sent to <strong>{step.email}</strong>.
            </p>
            <label>
              6-digit code
              <input
                className="code-input"
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                disabled={state.working}
                aria-invalid={state.problem === "invalidCode" || state.problem === "codeExpired"}
                aria-describedby={state.problem ? "sign-in-problem" : undefined}
                autoFocus
              />
            </label>
            <button type="submit" className="btn btn-primary" disabled={state.working}>
              {state.working ? "Please wait…" : "Verify and sign in"}
            </button>
            <div className="row spread">
              <ResendButton flow={flow} availableAtMs={state.resendAvailableAtMs} working={state.working} />
              <button type="button" className="btn btn-link" onClick={changeEmail} disabled={state.working}>
                Use a different email
              </button>
            </div>
          </form>
        )}
        {state.problem ? (
          <p id="sign-in-problem" className="error-text" role="alert">
            {problemMessage(state.problem)}
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** "Send a new code", counting down while the 30-second wait runs. */
function ResendButton({
  flow,
  availableAtMs,
  working,
}: {
  flow: SignInFlow;
  availableAtMs: number | null;
  working: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (availableAtMs === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [availableAtMs]);
  const wait = availableAtMs === null ? 0 : Math.max(0, Math.ceil((availableAtMs - now) / 1000));
  return (
    <button type="button" className="btn btn-link" onClick={() => void flow.resend()} disabled={working || wait > 0}>
      {wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}
    </button>
  );
}
