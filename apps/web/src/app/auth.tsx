import { ClerkProvider, SignedIn, SignedOut, SignInButton, useAuth as useClerkAuth } from "@clerk/clerk-react";
import type { PropsWithChildren } from "react";
import { readConfigValue } from "./runtime-config";

const configuredPublishableKey = readConfigValue("VITE_CLERK_PUBLISHABLE_KEY");
const publishableKey = configuredPublishableKey?.endsWith("_replace_me") ? undefined : configuredPublishableKey;
const localAuthBypass = readConfigValue("VITE_LOCAL_AUTH_BYPASS") === "true";
const localAuthBypassToken = "local.eyJzdWIiOiJkZW1vX2FnZW50X21hcmluYSJ9.bypass";
const localAuth = {
  getToken: async () => localAuthBypassToken
};

export function AuthProvider({ children }: PropsWithChildren) {
  if (localAuthBypass) {
    return <>{children}</>;
  }

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

export function useTalkAuth() {
  if (localAuthBypass) {
    return localAuth;
  }

  return useClerkAuth();
}
