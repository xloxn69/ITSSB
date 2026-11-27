import { ClerkProvider, useAuth, useClerk, useSignIn, useSignUp } from "@clerk/react";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useEffect, useMemo, useRef, useState } from "react";
import { FamilyApp } from "../family/FamilyApp";
import { convexFamilySource } from "../family/familySource";
import { TrackPage } from "../family/TrackPage";
import { Shell } from "../Shell";
import { convexStaffSource } from "../staff/convexStaffSource";
import { StaffApp } from "../staff/StaffApp";
import { TrackStore } from "../tracking/store";
import type { LiveConfig } from "./config";
import { convexSource } from "./convexSource";
import { SignInFlow, type SignInLike, type SignUpLike, sessionGate } from "./signInFlow";
import { SignInScreen } from "./SignInScreen";

/**
 * Signed-in app: Clerk proves identity through our own sign-in screen
 * (docs/17 §8; no Clerk prebuilt components), Convex verifies the token
 * on the server, and every query re-derives access from that identity.
 * Nothing protected is requested until Convex reports an authenticated
 * session.
 */
export function LiveApp({ config }: { config: LiveConfig }) {
  const client = useMemo(() => new ConvexReactClient(config.convexUrl), [config.convexUrl]);
  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey}>
      <ConvexProviderWithClerk client={client} useAuth={useAuth}>
        <AuthGate client={client} />
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

function AuthGate({ client }: { client: ConvexReactClient }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { isSignedIn } = useAuth();
  const clerk = useClerk();
  const waitingMs = useWaitingMs(!isLoading && !isAuthenticated && isSignedIn === true);
  const gate = sessionGate({
    convexLoading: isLoading,
    convexAuthenticated: isAuthenticated,
    clerkSignedIn: isSignedIn === true,
    waitingMs,
  });
  if (gate === "checking") {
    return (
      <Shell>
        <section className="card message" aria-busy>
          <h2>Checking your sign-in…</h2>
        </section>
      </Shell>
    );
  }
  const signOut = () => void clerk.signOut();
  if (gate === "refused") {
    // Clerk has a session but Convex refused its token (for example, the
    // `convex` JWT template or issuer is not set up). Say so; never show data.
    return (
      <Shell
        right={
          <button type="button" className="btn" onClick={signOut}>
            Sign out
          </button>
        }
      >
        <section className="card message" role="alert">
          <h2>Signed in, but not accepted yet</h2>
          <p className="muted">
            The tracking service didn't accept this sign-in. Your school's setup may not be finished. Sign out and try
            again later.
          </p>
        </section>
      </Shell>
    );
  }
  if (gate === "signIn") {
    return (
      <Shell>
        <ClerkSignIn />
      </Shell>
    );
  }
  return (
    <Shell
      right={
        <button type="button" className="btn" onClick={signOut}>
          Sign out
        </button>
      }
    >
      <SignedIn client={client} onSignIn={signOut} />
    </Shell>
  );
}

/** Milliseconds `active` has been continuously true; 0 while it is false. */
function useWaitingMs(active: boolean): number {
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setSince(null);
      return;
    }
    const start = Date.now();
    setSince(start);
    setNow(start);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active && since !== null ? now - since : 0;
}

/**
 * Connects our sign-in screen to Clerk's headless hooks. The flow reads the
 * latest resources through refs, because Clerk replaces them as an attempt
 * moves on.
 */
function ClerkSignIn() {
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const signInRef = useRef<SignInLike>(signIn);
  const signUpRef = useRef<SignUpLike>(signUp);
  signInRef.current = signIn;
  signUpRef.current = signUp;
  const flow = useMemo(
    () => new SignInFlow({ signIn: () => signInRef.current, signUp: () => signUpRef.current }),
    [],
  );
  return <SignInScreen flow={flow} />;
}

/** `#/staff/…` opens the staff console; the server still checks the staff role on every call. */
function SignedIn({ client, onSignIn }: { client: ConvexReactClient; onSignIn: () => void }) {
  const [staff, setStaff] = useState(() => location.hash.startsWith("#/staff"));
  useEffect(() => {
    const onChange = () => setStaff(location.hash.startsWith("#/staff"));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const staffSource = useMemo(() => convexStaffSource(client), [client]);
  return staff ? <StaffApp source={staffSource} /> : <SignedInTrack client={client} onSignIn={onSignIn} />;
}

function SignedInTrack({ client, onSignIn }: { client: ConvexReactClient; onSignIn: () => void }) {
  // One store per signed-in session; unmounting on sign-out stops every
  // subscription and drops protected data.
  const store = useMemo(() => new TrackStore(convexSource(client)), [client]);
  const family = useMemo(() => convexFamilySource(client), [client]);
  return <FamilyApp source={family} track={<TrackPage store={store} onSignIn={onSignIn} />} />;
}
