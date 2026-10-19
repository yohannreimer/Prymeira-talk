import { renderToStaticMarkup } from "react-dom/server";
import type { ChannelDto } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import {
  AutomationWebhookTriggerView,
  automationWebhookExampleBody,
  channelOptionLabel,
  metaChannelWebhookWarning
} from "./AutomationWebhookTriggerPanel";

const evolutionChannel: ChannelDto = {
  id: "channel-evolution",
  workspaceId: "workspace-1",
  provider: "evolution",
  providerKey: "talk-instance",
  phoneNumber: "5547999990000",
  displayName: "Comercial",
  status: "connected",
  createdAt: "2026-10-11T12:00:00.000Z",
  updatedAt: "2026-10-11T12:00:00.000Z"
};
const metaChannel: ChannelDto = {
  ...evolutionChannel,
  id: "channel-meta",
  provider: "meta_cloud",
  providerKey: "phone-number-id",
  displayName: null
};

function renderView(overrides: Partial<Parameters<typeof AutomationWebhookTriggerView>[0]> = {}) {
  return renderToStaticMarkup(
    <AutomationWebhookTriggerView
      automationId="automation-1"
      channelId="channel-evolution"
      channels={[evolutionChannel, metaChannel]}
      copied={false}
      error={null}
      isLoading={false}
      isRegenerating={false}
      onChannelChange={vi.fn()}
      onCopy={vi.fn()}
      onRegenerate={vi.fn()}
      webhook={{
        automationId: "automation-1",
        token: "abc",
        path: "/webhooks/automations/abc",
        createdAt: "2026-10-11T12:00:00.000Z",
        updatedAt: "2026-10-11T12:00:00.000Z"
      }}
      {...overrides}
    />
  );
}

describe("AutomationWebhookTriggerView", () => {
  it("shows the public link, copy and regenerate actions, the channel selector and a JSON example", () => {
    const html = renderView();

    expect(html).toContain("http://localhost:3002/webhooks/automations/abc");
    expect(html).toContain("Copiar link");
    expect(html).toContain("Regenerar link");
    expect(html).toContain("Canal do WhatsApp");
    expect(html).toContain("Comercial");
    expect(html).toContain("5547999990000 (API oficial)");
    expect(html).toContain("Exemplo de envio (POST JSON)");
    expect(html).toContain("&quot;whatsapp&quot;: &quot;(47) 99999-1234&quot;");
    expect(html).toContain("Ativar agente");
    expect(html).not.toContain(metaChannelWebhookWarning);
  });

  it("asks to save the flow before showing a link", () => {
    const html = renderView({ automationId: null, webhook: null });

    expect(html).toContain("Salve o fluxo para gerar o link deste webhook.");
    expect(html).not.toContain("Copiar link");
  });

  it("warns that Meta channels cannot send the first message without templates", () => {
    const html = renderView({ channelId: "channel-meta" });

    expect(html).toContain(metaChannelWebhookWarning);
  });

  it("documents the Prymeira site payload in the example", () => {
    expect(Object.keys(automationWebhookExampleBody)).toEqual([
      "nome",
      "whatsapp",
      "empresa",
      "faturamento",
      "dor",
      "equipe",
      "utm",
      "pagina",
      "enviado_em"
    ]);
    expect(channelOptionLabel(evolutionChannel)).toBe("Comercial");
  });
});
