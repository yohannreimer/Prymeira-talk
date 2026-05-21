import { ClerkProvider, SignedIn, SignedOut, SignInButton } from "@clerk/clerk-react";
import type { PropsWithChildren } from "react";

const configuredPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const publishableKey = configuredPublishableKey?.endsWith("_replace_me") ? undefined : configuredPublishableKey;
const localAuthBypass = import.meta.env.VITE_LOCAL_AUTH_BYPASS === "true";

export function AuthProvider({ children }: PropsWithChildren) {
  if (!publishableKey) {
    return <div className="center-state">Configure VITE_CLERK_PUBLISHABLE_KEY.</div>;
  }

  return <ClerkProvider publishableKey={publishableKey}>{children}</ClerkProvider>;
}

export function AuthGate({ children }: PropsWithChildren) {
  if (localAuthBypass) {
    return <>{children}</>;
  }

  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <div className="center-state">
          <h1>Prymeira Talk</h1>
          <SignInButton mode="modal">
            <button className="primary-button">Entrar</button>
          </SignInButton>
        </div>
      </SignedOut>
    </>
  );
}
