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

  it("encodes workspace ids in webhook URLs", () => {
    const runtime = createEvolutionRuntime({
      mode: "simulated",
      publicTalkUrl: "https://talk.prymeiradigital.com.br",
      localTalkUrl: "http://localhost:3002",
      apiBaseUrl: undefined,
      apiKey: undefined,
      webhookSecret: "replace_me"
    });

    expect(runtime.publicWebhookUrl("workspace with/slash")).toBe(
      "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace%20with%2Fslash"
    );
    expect(runtime.localWebhookUrl("workspace with/slash")).toBe(
      "http://localhost:3002/webhooks/evolution/workspace%20with%2Fslash"
    );
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
    expect(result.instanceName).toBe("talk-local_workspace-abc");
    expect(result.qrCode).toBe("2@qr-code");
  });

  it("uses the provider returned instance name when create instance includes one", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({
        instance: { instanceName: "provider-instance-name" },
        qrcode: { code: "2@qr-code" }
      })
    );
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    const result = await client.createInstance({
      instanceName: "requested-instance-name",
      webhookUrl: "https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace",
      webhookSecret: "webhook-secret"
    });

    expect(result.instanceName).toBe("provider-instance-name");
  });

  it("returns null when create instance response has no QR string", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({
        instance: { instanceName: "talk-local_workspace-abc" },
        qrcode: { pairingCode: 123456 }
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

    expect(result).toMatchObject({
      instanceName: "talk-local_workspace-abc",
      qrCode: null
    });
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
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      number: "5547999990000",
      text: "Oi",
      linkPreview: false
    });
    expect(result.providerMessageId).toBe("provider_msg_1");
  });

  it("allows link preview to be explicitly enabled for text messages", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({ key: { id: "provider_msg_1" } })
    );
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    await client.sendText({
      instanceName: "talk-local_workspace-abc",
      number: "5547999990000",
      text: "https://rubinot.com.br/characters?name=Thiiszk",
      linkPreview: true
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      number: "5547999990000",
      text: "https://rubinot.com.br/characters?name=Thiiszk",
      linkPreview: true
    });
  });

  it("sends a media message with raw base64 in the provider payload", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({ key: { id: "provider_media_1" } })
    );
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    const result = await client.sendMedia({
      instanceName: "talk-local_workspace-abc",
      number: "5547999990000",
      mediatype: "image",
      mimetype: "image/png",
      media: "data:image/png;base64,aW1n",
      fileName: "foto.png",
      caption: "Oi"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://wsapi.yrdnegocios.com.br/message/sendMedia/talk-local_workspace-abc",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      number: "5547999990000",
      mediatype: "image",
      mimetype: "image/png",
      caption: "Oi",
      media: "aW1n",
      fileName: "foto.png"
    });
    expect(result.providerMessageId).toBe("provider_media_1");
  });

  it("sends an official template through Evolution", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({ key: { id: "provider_template_1" } })
    );
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    expect(client.sendTemplate).toBeDefined();
    const result = await client.sendTemplate!({
      instanceName: "official-instance",
      number: "5547999990000",
      name: "reactivation_vip",
      language: "pt_BR",
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: "Ana" }]
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://wsapi.yrdnegocios.com.br/message/sendTemplate/official-instance",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      number: "5547999990000",
      name: "reactivation_vip",
      language: "pt_BR",
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: "Ana" }]
        }
      ]
    });
    expect(result.providerMessageId).toBe("provider_template_1");
  });

  it("lists official templates through Evolution and normalizes nested responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({
        data: {
          templates: [
            {
              id: "tpl_1",
              name: "boas_vindas",
              language: "pt_BR",
              status: "APPROVED",
              category: "MARKETING",
              components: [
                {
                  type: "HEADER",
                  text: "Prymeira"
                },
                {
                  type: "BODY",
                  text: "Olá {{1}}, sua conta está pronta."
                }
              ]
            },
            {
              name: "sem_id",
              language: "en_US",
              components: []
            },
            {
              name: "sem_idioma"
            }
          ]
        }
      })
    );
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    expect(client.listTemplates).toBeDefined();
    const result = await client.listTemplates!({
      instanceName: "official-instance"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://wsapi.yrdnegocios.com.br/template/find/official-instance",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ apikey: "secret-key" })
      })
    );
    expect(result.templates).toEqual([
      {
        id: "tpl_1",
        name: "boas_vindas",
        language: "pt_BR",
        status: "APPROVED",
        category: "MARKETING",
        preview: "Olá {{1}}, sua conta está pronta.",
        components: [
          {
            type: "HEADER",
            text: "Prymeira"
          },
          {
            type: "BODY",
            text: "Olá {{1}}, sua conta está pronta."
          }
        ]
      },
      {
        id: "sem_id:en_US",
        name: "sem_id",
        language: "en_US",
        status: "UNKNOWN",
        category: "UNKNOWN",
        preview: null,
        components: []
      }
    ]);
  });

  it("lists official templates when Evolution returns an array directly", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse([
        {
          name: "alerta_pagamento",
          language: "pt_BR",
          components: [{ type: "BODY", text: "Seu pagamento foi confirmado." }]
        }
      ])
    );
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    const result = await client.listTemplates!({
      instanceName: "official-instance"
    });

    expect(result.templates).toEqual([
      expect.objectContaining({
        id: "alerta_pagamento:pt_BR",
        name: "alerta_pagamento",
        language: "pt_BR",
        preview: "Seu pagamento foi confirmado."
      })
    ]);
  });

  it("sets an instance webhook with the expected provider payload", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createJsonResponse({ ok: true }));
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    await client.setWebhook({
      instanceName: "talk-local_workspace-abc",
      webhookUrl: "https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace",
      webhookSecret: "webhook-secret"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://wsapi.yrdnegocios.com.br/webhook/set/talk-local_workspace-abc",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(
      expect.objectContaining({
        webhook: expect.objectContaining({
          enabled: true,
          url: "https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace",
          webhookByEvents: false,
          webhookBase64: true,
          headers: expect.objectContaining({
            "x-prymeira-talk-secret": "webhook-secret"
          }),
          events: expect.arrayContaining(["CONNECTION_UPDATE", "MESSAGES_UPSERT"])
        })
      })
    );
  });

  it("connects an existing instance and returns its QR code", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({
        code: "2@existing-qr",
        count: 1
      })
    );
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    const result = await client.connectInstance({
      instanceName: "talk-local_workspace-abc"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://wsapi.yrdnegocios.com.br/instance/connect/talk-local_workspace-abc",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ apikey: "secret-key" })
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        instanceName: "talk-local_workspace-abc",
        qrCode: "2@existing-qr"
      })
    );
  });

  it("redacts secret fields from successful raw responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({
        key: { id: "provider_msg_1" },
        hash: { apikey: "provider-api-key" },
        nested: [
          {
            authorization: "Bearer provider-token",
            profile: { password: "provider-password", displayName: "Agent" }
          }
        ]
      })
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

    expect(result.raw).toEqual({
      key: { id: "provider_msg_1" },
      hash: { apikey: "[redacted]" },
      nested: [
        {
          authorization: "[redacted]",
          profile: { password: "[redacted]", displayName: "Agent" }
        }
      ]
    });
    expect(result.providerMessageId).toBe("provider_msg_1");
  });

  it("returns null when send text response has no provider message id string", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({ key: { id: 123 }, message: { key: {} } })
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

    expect(result.providerMessageId).toBeNull();
  });

  it("throws an EvolutionClientError with a redacted response body when Evolution returns a non-2xx response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse(
        {
          error: "nope",
          hash: { api_key: "provider-api-key" },
          access_token: "provider-access-token"
        },
        401
      )
    );
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
      responseBody: {
        error: "nope",
        hash: { api_key: "[redacted]" },
        access_token: "[redacted]"
      }
    });
    await expect(promise).rejects.toBeInstanceOf(EvolutionClientError);
  });
});
