import { afterEach, describe, expect, it, vi } from "vitest";
import { apiSupervisionConversations, apiSupervisionMedia, apiSupervisionPreview, apiSupervisionSummary, apiSupervisionThread } from "./supervision-api";

const getToken = async () => "supervisor-token";
const sellerCustomerId = "00000000-0000-4000-8000-000000000001";
afterEach(() => vi.unstubAllGlobals());

describe("supervisor API transport", () => {
  it("keeps seller, next action, unread and status filters independent and forwards opaque pagination", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversations: [], nextCursor: "next-page" })));
    vi.stubGlobal("fetch", fetch);
    await expect(apiSupervisionConversations({ sellerCustomerId, status: "active", nextAction: true, unread: true }, getToken, undefined, "opaque-boundary"))
      .resolves.toEqual({ conversations: [], nextCursor: "next-page" });
    const url = new URL(fetch.mock.calls[0][0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ sellerCustomerId, status: "active", nextAction: "true", unread: "true", cursor: "opaque-boundary" });
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer supervisor-token" }, cache: "no-store" });
    expect(fetch.mock.calls[0][1].method ?? "GET").toBe("GET");
  });

  it("returns server conversation counts without reducing them to page length", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ sellers: [{
      sellerCustomerId, sellerName: "Vendedor 1", sellerEmail: "vendedor@example.test", nextActionCount: 83, unreadConversationCount: 62
    }] }))));
    const summary = await apiSupervisionSummary(getToken);
    expect(summary.sellers[0]).toMatchObject({ nextActionCount: 83, unreadConversationCount: 62 });
  });

  it("sends the same unread period to full summary and paginated combined filters", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sellers: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ conversations: [], nextCursor: null })));
    vi.stubGlobal("fetch", fetch);
    const abort = new AbortController();
    await apiSupervisionSummary(getToken, abort.signal, "24h");
    await apiSupervisionConversations({ sellerCustomerId, status: "active", nextAction: true, unread: true, unreadPeriod: "24h" }, getToken, abort.signal, "next-page");
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("unreadPeriod")).toBe("24h");
    expect(Object.fromEntries(new URL(fetch.mock.calls[1][0]).searchParams)).toMatchObject({
      unreadPeriod: "24h", sellerCustomerId, unread: "true", nextAction: "true", cursor: "next-page"
    });
    for (const [, init] of fetch.mock.calls) {
      expect(init.signal).toBe(abort.signal);
      expect(init.method ?? "GET").toBe("GET");
    }
  });

  it("routes media and previews through scoped read-only supervisor paths", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("image", { headers: { "content-type": "image/png" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ imageUrl: "data:image/png;base64,aQ==", pages: 3 })));
    vi.stubGlobal("fetch", fetch);
    expect((await apiSupervisionMedia("workspace", "conversation", "message", getToken)).type).toBe("image/png");
    await expect(apiSupervisionPreview("workspace", "conversation", "message", 2, getToken)).resolves.toMatchObject({ pages: 3 });
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/supervision/workspaces/workspace/conversations/conversation/messages/message/media",
      "/supervision/workspaces/workspace/conversations/conversation/messages/message/preview"
    ]);
    for (const [, init] of fetch.mock.calls) expect(init.method ?? "GET").toBe("GET");
  });

  it("propagates abort signals and explicit revoked/inaccessible statuses for UI cleanup", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Vínculo revogado." }), { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    const abort = new AbortController();
    await expect(apiSupervisionThread("workspace", "conversation", getToken, abort.signal)).rejects.toMatchObject({ status: 403, message: "Vínculo revogado." });
    expect(fetch.mock.calls[0][1].signal).toBe(abort.signal);
    await expect(apiSupervisionSummary(async () => null)).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
