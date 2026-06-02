import { describe, expect, it, vi } from "vitest";
import { createMetaClient, MetaClientError } from "./meta.client.js";

describe("createMetaClient", () => {
  it("sends a free-text WhatsApp message through Graph API", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [{ id: "wamid_text_1" }]
        }),
        { status: 200 }
      )
    );
    const client = createMetaClient({
      graphApiBaseUrl: "https://graph.facebook.com/v23.0",
      accessToken: "token",
      fetch
    });

    const result = await client.sendText({
      phoneNumberId: "222",
      to: "5511999999999",
      text: "Oi"
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://graph.facebook.com/v23.0/222/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: "5511999999999",
          type: "text",
          text: { preview_url: false, body: "Oi" }
        })
      })
    );
    expect(result.providerMessageId).toBe("wamid_text_1");
  });

  it("sends a template WhatsApp message through Graph API", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [{ id: "wamid_template_1" }]
        }),
        { status: 200 }
      )
    );
    const client = createMetaClient({
      graphApiBaseUrl: "https://graph.facebook.com/v23.0",
      accessToken: "token",
      fetch
    });

    const result = await client.sendTemplate({
      phoneNumberId: "222",
      to: "5511999999999",
      name: "hello_world",
      language: "pt_BR",
      components: [{ type: "body", parameters: [{ type: "text", text: "Yohann" }] }]
    });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      type: "template",
      template: {
        name: "hello_world",
        language: { code: "pt_BR" },
        components: [{ type: "body" }]
      }
    });
    expect(result.providerMessageId).toBe("wamid_template_1");
  });

  it("lists templates for a WABA across Graph API pages", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "tpl_1",
                name: "approved",
                language: "pt_BR",
                category: "UTILITY",
                status: "APPROVED",
                components: []
              }
            ],
            paging: {
              next: "https://graph.facebook.com/v23.0/111/message_templates?after=cursor"
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "tpl_2",
                name: "paused",
                language: "pt_BR",
                category: "MARKETING",
                status: "PAUSED",
                components: []
              }
            ]
          }),
          { status: 200 }
        )
      );
    const client = createMetaClient({
      graphApiBaseUrl: "https://graph.facebook.com/v23.0",
      accessToken: "token",
      fetch
    });

    const result = await client.listMessageTemplates({ wabaId: "111" });

    expect(fetch).toHaveBeenCalledWith(
      "https://graph.facebook.com/v23.0/111/message_templates?fields=id,name,language,category,status,components&limit=100",
      expect.objectContaining({ method: "GET" })
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://graph.facebook.com/v23.0/111/message_templates?after=cursor",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer token" })
      })
    );
    expect(result.templates).toHaveLength(2);
  });

  it("throws sanitized errors", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "Invalid token", access_token: "secret" }
        }),
        { status: 401 }
      )
    );
    const client = createMetaClient({
      graphApiBaseUrl: "https://graph.facebook.com/v23.0",
      accessToken: "token",
      fetch
    });

    try {
      await client.listMessageTemplates({ wabaId: "111" });
      expect.fail("Expected MetaClientError");
    } catch (error) {
      expect(error).toBeInstanceOf(MetaClientError);
      expect(error).toMatchObject({
        statusCode: 401,
        responseBody: {
          error: { message: "Invalid token", access_token: "[redacted]" }
        }
      });
    }
  });

  it("preserves plain text failed responses", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("temporarily unavailable", { status: 503 }));
    const client = createMetaClient({
      graphApiBaseUrl: "https://graph.facebook.com/v23.0",
      accessToken: "token",
      fetch
    });

    await expect(client.testConnection({ phoneNumberId: "222" })).rejects.toMatchObject({
      statusCode: 503,
      responseBody: "temporarily unavailable"
    });
  });
});
