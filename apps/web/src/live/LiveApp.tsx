import { ClerkProvider, SignIn, useAuth, useClerk } from "@clerk/react";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useEffect, useMemo, useState } from "react";
import { FamilyApp } from "../family/FamilyApp";
import { convexFamilySource } from "../family/familySource";
import { TrackPage } from "../family/TrackPage";
import { Shell } from "../Shell";
import { convexStaffSource } from "../staff/convexStaffSource";
import { StaffApp } from "../staff/StaffApp";
import { TrackStore } from "../tracking/store";
import type { LiveConfig } from "./config";
import { convexSource } from "./convexSource";

/**
 * Signed-in app: Clerk handles sign-in (docs/17), Convex verifies the token
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
  const clerk = useClerk();
  if (isLoading) {
    return (
      <Shell>
        <section className="card message" aria-busy>
          <h2>Checking your sign-in…</h2>
        </section>
      </Shell>
    );
  }
  if (!isAuthenticated) {
    return (
      <Shell>
        <div className="stack" style={{ alignItems: "center" }}>
          <h1>Sign in to see your bus</h1>
          <SignIn routing="hash" />
        </div>
      </Shell>
    );
  }
  const signOut = () => void clerk.signOut();
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
