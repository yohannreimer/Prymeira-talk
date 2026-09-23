import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CampaignAudiencePreviewDto, CampaignDto } from "../../app/api";
import { CampaignReview } from "./CampaignReview";
import { GuidedCampaignEditor, SAFE_CADENCE, zonedDateTimeToIso } from "./GuidedCampaignEditor";

const campaign: CampaignDto = {
  id: "11111111-1111-4111-8111-111111111111", workspaceId: "workspace",
  name: "Prospecção — Leads", status: "draft", audience: {
    type: "imported", origin: "leads", selectedCount: 26,
    rows: [{ name: "Academia A", phone: "5547999999999", fields: {} }]
  }, messageBody: "Olá {{nome}}", templates: ["Olá {{nome}}"],
  fallbackName: "cliente", cadence: SAFE_CADENCE, scheduledAt: null,
  mode: "simulated", createdAt: "2026-09-22T12:00:00Z", updatedAt: "2026-09-22T12:00:00Z"
};

const preview: CampaignAudiencePreviewDto = {
  selectedCount: 26,
  eligible: [{ contactId: null, audienceKey: "a", name: "Academia A",
    phone: "5547999999999", normalizedPhone: "5547999999999", fields: {},
    message: "Olá Academia A" }],
  excluded: [{ contactId: null, audienceKey: "b", name: "Academia B",
    phone: "5547888888888", fields: {}, reason: "no_whatsapp" }],
  checkedAt: "2026-09-22T12:00:00Z", audienceHash: "a".repeat(64),
  revision: "2026-09-22T12:00:00Z", unresolvedVariables: []
};

describe("guided campaign editor", () => {
  it("identifies Leads drafts and hides real-send actions before review", () => {
    const html = renderToStaticMarkup(<GuidedCampaignEditor campaign={campaign}
      boards={[]} channels={[]} getToken={async () => null} parseFile={async () => []}
      onSaved={vi.fn()} onBack={vi.fn()} onMeta={vi.fn()} />);
    expect(html).toContain("Destinatários");
    expect(html).toContain("Mensagem e horário");
    expect(html).toContain("Revisar e enviar");
    expect(html).toContain("Lista vinda de Leads");
    expect(html).toContain("26 selecionados originalmente");
    expect(html).not.toContain("Iniciar envio para");
    expect(html).not.toContain("Enviar real");
  });

  it("makes eligible, excluded and confirmation explicit", () => {
    const html = renderToStaticMarkup(<CampaignReview preview={preview}
      message="Olá Academia A" channelName="Geral" startLabel="Agora"
      cadence={SAFE_CADENCE} confirmed={false} onConfirmedChange={vi.fn()} />);
    expect(html).toContain("26");
    expect(html).toContain("com WhatsApp confirmado");
    expect(html).toContain("Sem WhatsApp: 1");
    expect(html).toContain("24 não entraram no rascunho");
    expect(html).toContain("autorização");
    expect(html).not.toContain('checked=""');
  });

  it("does not invent the original selection for older drafts", () => {
    const html = renderToStaticMarkup(<CampaignReview preview={{ ...preview,
      selectedCount: null }} message="Olá" channelName="Geral" startLabel="Agora"
      cadence={SAFE_CADENCE} confirmed={false} onConfirmedChange={vi.fn()} />);
    expect(html).toContain("originalmente selecionada não está disponível");
  });

  it("interprets scheduled time in the selected campaign timezone", () => {
    expect(zonedDateTimeToIso("2026-09-22T09:00", "America/Sao_Paulo"))
      .toBe("2026-09-22T12:00:00.000Z");
    expect(zonedDateTimeToIso("2026-09-22T09:00", "America/Manaus"))
      .toBe("2026-09-22T13:00:00.000Z");
  });
});
