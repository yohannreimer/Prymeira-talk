import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("buildRealtimeUrl", () => {
  it("preserves the API base path without putting bearer tokens in the URL", async () => {
    vi.stubEnv("VITE_API_URL", "https://talk.prymeiradigital.com.br/api");

    const { buildRealtimeAuthProtocols, buildRealtimeUrl } = await import("./api");

    expect(buildRealtimeUrl()).toBe("wss://talk.prymeiradigital.com.br/api/realtime");
    expect(buildRealtimeAuthProtocols("token_1")).toEqual(["prymeira-talk-auth", "token_1"]);
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
      isPrimaryPipeline: true,
      channels: [
        {
          id: "channel-1",
          displayName: "WhatsApp Vendas",
          provider: "evolution",
          phoneNumber: "+5511999990000"
        }
      ],
      createdAt: "2026-05-24T12:00:00.000Z",
      stages: []
    };
    const stage = {
      id: "stage-1",
      workspaceId: "workspace_a",
      boardId: "board-1",
      name: "Novo",
      color: "#24564a",
      order: 0,
      tagTriggers: [{ id: "tag-1", name: "lead_quente", color: "#24564a", isActive: true }]
    };
    const syncResult = {
      evaluated: 12,
      added: 4,
      moved: 2,
      ignored: 6,
      conflicts: 0
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
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(syncResult), {
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
      apiDeleteBoard,
      apiSyncBoardRules
    } = await import("./api");

    await expect(
      apiCreateBoard(async () => null, {
        name: "Vendas",
        description: "",
        channelIds: ["channel-1"],
        isPrimaryPipeline: true
      })
    ).resolves.toMatchObject({ isPrimaryPipeline: true, channels: [{ id: "channel-1" }] });
    await expect(
      apiUpdateBoard(async () => null, "board-1", { name: "Comercial" })
    ).resolves.toMatchObject({ name: "Comercial" });
    await expect(
      apiCreateBoardStage(async () => null, "board-1", {
        name: "Novo",
        color: "#24564a",
        order: 0,
        tagIds: ["tag-1"]
      })
    ).resolves.toMatchObject({ tagTriggers: [{ id: "tag-1" }] });
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
    await expect(apiSyncBoardRules(async () => null, "board-1", "all")).resolves.toEqual(
      syncResult
    );

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
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      channelIds: ["channel-1"],
      isPrimaryPipeline: true
    });
  });
});

describe("tag catalog API helpers", () => {
  const tag = {
    id: "tag-1",
    workspaceId: "workspace_a",
    name: "Lead quente",
    color: "#2f6b57",
    useGuide: "Quando o cliente pedir preço ou demonstração.",
    isActive: true,
    agentCount: 1,
    conversationCount: 3,
    createdAt: "2026-07-05T12:00:00.000Z",
    updatedAt: "2026-07-05T12:00:00.000Z"
  };

  it("calls tag catalog endpoints with correct methods and parses responses", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([tag]), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...tag, name: "Aguardando comercial" }), {
          status: 201,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...tag, isActive: false }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();

    const { apiCreateTag, apiGetTags, apiUpdateTag } = await import("./api");

    await expect(apiGetTags(async () => null)).resolves.toEqual([tag]);
    await expect(
      apiCreateTag(async () => null, {
        name: "Aguardando comercial",
        color: "#7c3aed",
        useGuide: "Quando precisa de atendimento humano.",
        isActive: true
      })
    ).resolves.toMatchObject({ name: "Aguardando comercial" });
    await expect(
      apiUpdateTag(async () => null, "tag-1", {
        isActive: false
      })
    ).resolves.toMatchObject({ id: "tag-1", isActive: false });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3002/tags",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer local-dev-bypass" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3002/tags",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Aguardando comercial",
          color: "#7c3aed",
          useGuide: "Quando precisa de atendimento humano.",
          isActive: true
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://localhost:3002/tags/tag-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ isActive: false })
      })
    );
  });
});

describe("agent API helpers", () => {
  const agent = {
    id: "agent-1",
    workspaceId: "workspace_a",
    name: "Prymeira Vendedora",
    description: null,
    status: "active",
    providerMode: "prymeira_managed",
    provider: "simulated",
    model: "prymeira-simulated",
    systemPrompt: "Atenda bem.",
    behaviorConfig: {},
    handoffConfig: {},
    limitsConfig: {},
    allowedActions: ["send_message", "add_tag"],
    allowedTags: [
      {
        id: "tag-1",
        name: "Lead quente",
        color: "#2f6b57",
        useGuide: "Quando o cliente pedir preço ou demonstração."
      }
    ],
    createdAt: "2026-07-05T12:00:00.000Z",
    updatedAt: "2026-07-05T12:00:00.000Z"
  };

  it("sends allowed tag ids through create and update agent bodies", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(agent), {
          status: 201,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(agent), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();

    const { apiCreateAgent, apiUpdateAgent } = await import("./api");

    await apiCreateAgent(async () => null, {
      name: "Prymeira Vendedora",
      systemPrompt: "Atenda bem.",
      allowedActions: ["send_message", "add_tag"],
      allowedTagIds: ["tag-1", "tag-2"]
    });
    await apiUpdateAgent(async () => null, "agent-1", {
      allowedTagIds: ["tag-2"]
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3002/agents",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Prymeira Vendedora",
          systemPrompt: "Atenda bem.",
          allowedActions: ["send_message", "add_tag"],
          allowedTagIds: ["tag-1", "tag-2"]
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3002/agents/agent-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ allowedTagIds: ["tag-2"] })
      })
    );
  });
});
