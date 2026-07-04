import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("buildRealtimeUrl", () => {
  it("preserves the API base path for websocket connections", async () => {
    vi.stubEnv("VITE_API_URL", "https://talk.prymeiradigital.com.br/api");

    const { buildRealtimeUrl } = await import("./api");

    expect(buildRealtimeUrl("token_1")).toBe(
      "wss://talk.prymeiradigital.com.br/api/realtime?token=token_1"
    );
  });
});

describe("readApiErrorMessage", () => {
  it("uses structured API error bodies before falling back to HTTP status", async () => {
    const { readApiErrorMessage } = await import("./api");

    const response = new Response(
      JSON.stringify({
        code: "EVOLUTION_LICENSE_REQUIRED",
        error: "Evolution API exige ativação da licenca."
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );

    await expect(readApiErrorMessage(response, "Failed to start channel QR")).resolves.toBe(
      "Evolution API exige ativação da licenca."
    );
  });
});

describe("apiDeleteChannel", () => {
  it("sends DELETE to the channel endpoint", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, channelId: "channel-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.resetModules();

    const { apiDeleteChannel } = await import("./api");
    await expect(apiDeleteChannel(async () => null, "channel-1")).resolves.toEqual({
      ok: true,
      channelId: "channel-1"
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3002/channels/channel-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer local-dev-bypass"
        })
      })
    );
  });

  it("rejects malformed successful responses", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, channelId: "" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.resetModules();

    const { apiDeleteChannel } = await import("./api");

    await expect(apiDeleteChannel(async () => null, "channel-1")).rejects.toThrow(
      "Invalid delete channel response."
    );
  });
});

describe("board administration API helpers", () => {
  it("sends board and stage administration requests to the board endpoints", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");

    const board = {
      id: "board-1",
      workspaceId: "workspace_a",
      name: "Vendas",
      description: null,
      createdAt: "2026-05-24T12:00:00.000Z",
      stages: []
    };
    const stage = {
      id: "stage-1",
      workspaceId: "workspace_a",
      boardId: "board-1",
      name: "Novo",
      color: "#24564a",
      order: 0
    };
    const membershipDelete = {
      ok: true,
      membershipId: "membership-1",
      boardId: "board-1",
      contactId: "contact-1"
    };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(board), {
          status: 201,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...board, name: "Comercial" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(stage), {
          status: 201,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...stage, name: "Qualificado" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ ...stage, order: 0 }]), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, stageId: "stage-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(membershipDelete), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, boardId: "board-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();

    const {
      apiCreateBoard,
      apiUpdateBoard,
      apiCreateBoardStage,
      apiUpdateBoardStage,
      apiReorderBoardStages,
      apiDeleteBoardStage,
      apiRemoveBoardMembership,
      apiDeleteBoard
    } = await import("./api");

    await expect(
      apiCreateBoard(async () => null, { name: "Vendas", description: "" })
    ).resolves.toMatchObject({ id: "board-1", name: "Vendas" });
    await expect(
      apiUpdateBoard(async () => null, "board-1", { name: "Comercial" })
    ).resolves.toMatchObject({ name: "Comercial" });
    await expect(
      apiCreateBoardStage(async () => null, "board-1", {
        name: "Novo",
        color: "#24564a",
        order: 0
      })
    ).resolves.toMatchObject({ id: "stage-1" });
    await expect(
      apiUpdateBoardStage(async () => null, "board-1", "stage-1", {
        name: "Qualificado"
      })
    ).resolves.toMatchObject({ name: "Qualificado" });
    await expect(
      apiReorderBoardStages(async () => null, "board-1", ["stage-1"])
    ).resolves.toHaveLength(1);
    await expect(apiDeleteBoardStage(async () => null, "board-1", "stage-1")).resolves.toEqual({
      ok: true,
      stageId: "stage-1"
    });
    await expect(apiRemoveBoardMembership(async () => null, "membership-1")).resolves.toEqual(
      membershipDelete
    );
    await expect(apiDeleteBoard(async () => null, "board-1")).resolves.toEqual({
      ok: true,
      boardId: "board-1"
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3002/boards",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://localhost:3002/boards/board-1/stages",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "http://localhost:3002/boards/board-1/stages/reorder",
      expect.objectContaining({ method: "PATCH" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      7,
      "http://localhost:3002/board-memberships/membership-1",
      expect.objectContaining({ method: "DELETE" })
    );
  });
});
