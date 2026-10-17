// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const listFollowups = vi.fn();
const listeners = new Set<(event: { type: string }) => void>();
vi.mock("../../app/api", () => ({ apiListFollowups: (...args: unknown[]) => listFollowups(...args) }));
vi.mock("../../app/session/TalkSessionProvider", () => {
  const context = {
    getToken: async () => "token",
    realtime: { subscribe: (listener: (event: { type: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener); } }
  };
  return { useOptionalTalkSession: () => context };
});

import { useFollowupReviewCount } from "./useFollowupReviewCount";

describe("useFollowupReviewCount", () => {
  afterEach(() => { listFollowups.mockReset(); listeners.clear(); });

  it("counts the drafts waiting for a seller and recounts when a follow-up changes", async () => {
    listFollowups.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]).mockResolvedValue([{ id: "a" }]);
    vi.useFakeTimers();
    const container = document.createElement("div");
    const root = createRoot(container);
    function Probe() { return <span>{useFollowupReviewCount()}</span>; }
    await act(async () => { root.render(<Probe />); });
    expect(container.textContent).toBe("2");
    expect(listFollowups).toHaveBeenCalledWith(expect.any(Function), "review");

    await act(async () => {
      for (const listener of listeners) listener({ type: "conversation_followup.updated" });
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(container.textContent).toBe("1");
    act(() => root.unmount());
    vi.useRealTimers();
  });
});
