// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../app/App";

vi.mock("../../app/auth", () => ({ AuthGate: ({ children }: { children: React.ReactNode }) => <div data-auth-gate>{children}</div> }));
vi.mock("../../app/session/TalkSessionProvider", () => ({ TalkSessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../shell/TalkSuiteShell", () => ({ TalkSuiteShell: () => <div data-seller-shell>Seller modules</div> }));
vi.mock("./SupervisionPage", () => ({ SupervisionPage: () => <div data-supervision>Supervision only</div> }));

describe("entrada dedicada da supervisão", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const render = async (query: string) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.history.replaceState(null, "", `/${query}`);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<App />));
  };
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it("mounts only the authenticated dedicated screen for the Hub supervision URL", async () => {
    await render("?module=supervisao");
    expect(container.querySelector("[data-auth-gate] [data-supervision]")).not.toBeNull();
    expect(container.querySelector("[data-seller-shell]")).toBeNull();
    expect(window.location.search).toBe("?module=supervisao");
  });
  it("preserves ordinary seller routes and responds to history navigation", async () => {
    await render("?module=atendimento"); expect(container.querySelector("[data-seller-shell]")).not.toBeNull();
    await act(async () => { window.history.pushState(null, "", "/?module=supervisao"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(container.querySelector("[data-supervision]")).not.toBeNull(); expect(container.querySelector("[data-seller-shell]")).toBeNull();
    await act(async () => { window.history.pushState(null, "", "/?module=contatos"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(container.querySelector("[data-supervision]")).toBeNull(); expect(container.querySelector("[data-seller-shell]")).not.toBeNull();
  });
});
