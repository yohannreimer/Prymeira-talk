import { describe, expect, it, vi } from "vitest";
import { EvolutionClientError, createEvolutionClient } from "./evolution.client.js";
import { createEvolutionRuntime } from "./evolution-runtime.js";

describe("createEvolutionRuntime", () => {
  it("uses simulated mode when EVOLUTION_MODE is simulated", () => {
    const runtime = createEvolutionRuntime({
      mode: "simulated",
      publicTalkUrl: "https://talk.prymeiradigital.com.br",
      localTalkUrl: "http://localhost:3002",
      apiBaseUrl: undefined,
      apiKey: undefined,
      webhookSecret: "replace_me"
    });

    expect(runtime.mode).toBe("simulated");
    expect(runtime.publicWebhookUrl("local_workspace")).toBe(
      "https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace"
    );
    expect(runtime.localWebhookUrl("local_workspace")).toBe(
      "http://localhost:3002/webhooks/evolution/local_workspace"
    );
    expect(runtime.client).toBeNull();
  });

  it("creates a real client only when real mode has base url and api key", () => {
    const runtime = createEvolutionRuntime({
      mode: "real",
      publicTalkUrl: "https://talk.prymeiradigital.com.br",
      localTalkUrl: "http://localhost:3002",
      apiBaseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      webhookSecret: "webhook-secret"
    });

    expect(runtime.mode).toBe("real");
    expect(runtime.client).not.toBeNull();
  });

  it("falls back to simulated mode when real mode is missing credentials", () => {
    const runtime = createEvolutionRuntime({
      mode: "real",
      publicTalkUrl: "https://talk.prymeiradigital.com.br",
      localTalkUrl: "http://localhost:3002",
      apiBaseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: undefined,
      webhookSecret: "replace_me"
    });

    expect(runtime.mode).toBe("simulated");
    expect(runtime.client).toBeNull();
  });
});

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Evolution client", () => {
  it("creates an instance with QR and webhook config", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({
        instance: { instanceName: "talk-local_workspace-abc" },
        qrcode: { code: "2@qr-code" }
      })
    );
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    const result = await client.createInstance({
      instanceName: "talk-local_workspace-abc",
      webhookUrl: "https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace",
      webhookSecret: "webhook-secret"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://wsapi.yrdnegocios.com.br/instance/create",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ apikey: "secret-key" })
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(
      expect.objectContaining({
        instanceName: "talk-local_workspace-abc",
        integration: "WHATSAPP-BAILEYS",
        qrcode: true,
        webhook: expect.objectContaining({
          url: "https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace",
          byEvents: false,
          base64: true,
          headers: expect.objectContaining({
            "x-prymeira-talk-secret": "webhook-secret",
            "Content-Type": "application/json"
          }),
          events: expect.arrayContaining(["QRCODE_UPDATED", "CONNECTION_UPDATE", "MESSAGES_UPSERT"])
        })
      })
    );
    expect(result.qrCode).toBe("2@qr-code");
  });

  it("sends a text message and returns the provider message id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({ key: { id: "provider_msg_1" } })
    );
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    const result = await client.sendText({
      instanceName: "talk-local_workspace-abc",
      number: "5547999990000",
      text: "Oi"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://wsapi.yrdnegocios.com.br/message/sendText/talk-local_workspace-abc",
      expect.objectContaining({ method: "POST" })
    );
    expect(result.providerMessageId).toBe("provider_msg_1");
  });

  it("throws an EvolutionClientError when Evolution returns a non-2xx response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createJsonResponse({ error: "nope" }, 401));
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    const promise = client.sendText({
      instanceName: "talk-local_workspace-abc",
      number: "5547999990000",
      text: "Oi"
    });

    await expect(promise).rejects.toMatchObject({
      name: "EvolutionClientError",
      statusCode: 401,
      responseBody: { error: "nope" }
    });
    await expect(promise).rejects.toBeInstanceOf(EvolutionClientError);
  });
});
