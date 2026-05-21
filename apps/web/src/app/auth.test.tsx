import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/clerk-react", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => <div data-clerk-provider>{children}</div>,
  SignedIn: ({ children }: { children: ReactNode }) => <>{children}</>,
  SignedOut: ({ children }: { children: ReactNode }) => <>{children}</>,
  SignInButton: ({ children }: { children: ReactNode }) => <>{children}</>
}));

describe("AuthProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does not require Clerk configuration when local auth bypass is enabled", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_replace_me");

    const { AuthProvider } = await import("./auth");

    const html = renderToStaticMarkup(
      <AuthProvider>
        <span>Local shell</span>
      </AuthProvider>
    );

    expect(html).toContain("Local shell");
    expect(html).not.toContain("Configure VITE_CLERK_PUBLISHABLE_KEY");
  });

  it("provides an app auth hook that works without Clerk during local auth bypass", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_replace_me");

    const { useTalkAuth } = await import("./auth");
    let tokenGetterType = "unset";

    function LocalAuthProbe() {
      const { getToken } = useTalkAuth();
      tokenGetterType = typeof getToken;

      return <span>Local auth hook rendered</span>;
    }

    const html = renderToStaticMarkup(<LocalAuthProbe />);

    expect(html).toContain("Local auth hook rendered");
    expect(tokenGetterType).toBe("function");
  });

  it("returns the local bypass token from the app auth hook during local auth bypass", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_replace_me");

    const { useTalkAuth } = await import("./auth");
    let capturedGetToken: (() => Promise<string | null>) | null = null;

    function LocalAuthProbe() {
      capturedGetToken = useTalkAuth().getToken;

      return <span>Local auth hook rendered</span>;
    }

    renderToStaticMarkup(<LocalAuthProbe />);
    const getToken = capturedGetToken as (() => Promise<string | null>) | null;

    expect(getToken).not.toBeNull();
    await expect(getToken?.()).resolves.toBe("local.eyJzdWIiOiJkZW1vX2FnZW50X21hcmluYSJ9.bypass");
  });

  it("keeps the local token getter stable across local auth hook calls", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_replace_me");

    const { useTalkAuth } = await import("./auth");
    const first = useTalkAuth();
    const second = useTalkAuth();

    expect(first).toBe(second);
    expect(first.getToken).toBe(second.getToken);
  });
});
