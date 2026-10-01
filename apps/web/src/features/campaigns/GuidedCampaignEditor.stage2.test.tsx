// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDto } from "@prymeira-talk/shared";
import type { CampaignDto } from "../../app/api";
import { GuidedCampaignEditor, SAFE_CADENCE } from "./GuidedCampaignEditor";

const api = vi.hoisted(() => ({
  apiGenerateMessageVariations: vi.fn(),
  apiUpdateCampaign: vi.fn(),
  apiCreateCampaign: vi.fn(),
  apiGetSettings: vi.fn(),
  apiGetAgents: vi.fn(),
  apiGetBroadcastLists: vi.fn()
}));
vi.mock("../../app/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/api")>()),
  ...api
}));

const campaign: CampaignDto = {
  id: "11111111-1111-4111-8111-111111111111", workspaceId: "workspace",
  name: "Prospecção — Leads", status: "draft", audience: {
    type: "imported", origin: "leads", selectedCount: 26,
    rows: [{ name: "Academia A", phone: "5547999999999", fields: {} }]
  }, messageBody: "Olá {{nome}}, aço por R$ 10.", templates: ["Olá {{nome}}, aço por R$ 10."],
  fallbackName: "cliente", cadence: SAFE_CADENCE, scheduledAt: null,
  mode: "simulated", createdAt: "2026-09-22T12:00:00Z", updatedAt: "2026-09-22T12:00:00Z"
};
const channels: ChannelDto[] = [{ id: "channel-1", workspaceId: "workspace", provider: "evolution",
  providerKey: "instance-1", phoneNumber: null, displayName: "Vendas", status: "connected",
  createdAt: "2026-09-26T12:00:00.000Z", updatedAt: "2026-09-26T12:00:00.000Z" }];
const fiveVariations = [
  "Oi {{nome}}, aço por R$ 10.", "E aí {{nome}}, aço a R$ 10.", "{{nome}}, temos aço por R$ 10.",
  "Bom dia {{nome}}! Aço por R$ 10.", "Olá, {{nome}}. Aço custa R$ 10."
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("GuidedCampaignEditor stage 2", () => {
  let root: Root;
  let container: HTMLDivElement;
  const getToken = async () => "token";

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    for (const fn of Object.values(api)) fn.mockReset();
    api.apiGetSettings.mockResolvedValue({ modules: { campaignProspecting: false } });
    api.apiGetAgents.mockResolvedValue([]);
    api.apiGetBroadcastLists.mockResolvedValue([]);
    api.apiUpdateCampaign.mockImplementation(async (_token, _id, body) => ({ ...campaign, ...body }));
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
  const messageField = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
  const variationFields = () => [...container.querySelectorAll<HTMLTextAreaElement>(".message-variation textarea")];
  async function type(field: HTMLTextAreaElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(label: string) {
    const target = button(label);
    if (!target) throw new Error(`Botão não encontrado: ${label}`);
    await act(async () => target.click());
  }
  async function openStage2(draft: CampaignDto = campaign) {
    await act(async () => {
      root.render(<GuidedCampaignEditor campaign={draft} boards={[]} channels={channels}
        getToken={getToken} parseFile={async () => []} onSaved={vi.fn()} onBack={vi.fn()} onMeta={vi.fn()} />);
    });
    await click("Continuar para mensagem");
    expect(container.textContent).toContain("ETAPA 2 DE 3");
  }
  async function generateFive() {
    api.apiGenerateMessageVariations.mockResolvedValueOnce(fiveVariations);
    await click("Gerar 5 variações");
  }

  it("insere {{nome}} no ponto do cursor substituindo a seleção", async () => {
    await openStage2({ ...campaign, messageBody: "Olá XX, tudo bem?", templates: ["Olá XX, tudo bem?"] });
    const field = messageField();
    field.setSelectionRange(4, 6);
    await click("Inserir nome");
    expect(messageField().value).toBe("Olá {{nome}}, tudo bem?");
  });

  it("gera 5 variações a partir da mensagem sem espaços nas pontas", async () => {
    await openStage2();
    await type(messageField(), "  Olá {{nome}}, aço por R$ 10.  ");
    await generateFive();
    expect(api.apiGenerateMessageVariations).toHaveBeenCalledWith(getToken, "Olá {{nome}}, aço por R$ 10.");
    expect(container.textContent).toContain("Variações (5 de 5)");
    expect(variationFields().map((field) => field.value)).toEqual(fiveVariations);
    expect(container.textContent).not.toContain("A mensagem original mudou");
  });

  it("avisa quando a mensagem original muda depois de gerar as variações", async () => {
    await openStage2();
    await generateFive();
    await type(messageField(), "Olá {{nome}}, aço por R$ 12.");
    const notice = [...container.querySelectorAll('[role="status"]')]
      .find((item) => item.textContent?.includes("A mensagem original mudou"));
    expect(notice?.textContent).toBe("A mensagem original mudou depois que estas variações foram geradas. Revise cada uma ou gere de novo.");
  });

  it("descarta variações que chegam depois que a mensagem mudou", async () => {
    await openStage2();
    const pending = deferred<string[]>();
    api.apiGenerateMessageVariations.mockReturnValueOnce(pending.promise);
    await click("Gerar 5 variações");
    await type(messageField(), "Olá {{nome}}, aço por R$ 12.");
    await act(async () => { pending.resolve(fiveVariations); await pending.promise; });
    expect(variationFields()).toHaveLength(0);
    expect(container.textContent).toContain("A mensagem mudou enquanto as variações eram geradas. Gere novamente.");
  });

  it("salva o rascunho com a mensagem e as variações como templates", async () => {
    await openStage2();
    await generateFive();
    await type(variationFields()[1]!, "E aí {{nome}}, aço a R$ 10!");
    await click("Salvar rascunho");
    expect(api.apiUpdateCampaign).toHaveBeenCalledTimes(1);
    const body = api.apiUpdateCampaign.mock.calls[0]![2];
    expect(body.messageBody).toBe("Olá {{nome}}, aço por R$ 10.");
    expect(body.templates).toEqual(["Olá {{nome}}, aço por R$ 10.", fiveVariations[0],
      "E aí {{nome}}, aço a R$ 10!", ...fiveVariations.slice(2)]);
    expect(container.textContent).toContain("Rascunho salvo.");
  });

  it("bloqueia o salvamento quando uma variação perde um campo da original", async () => {
    await openStage2();
    await generateFive();
    await type(variationFields()[0]!, "Oi, aço por R$ 10.");
    await click("Salvar rascunho");
    expect(api.apiUpdateCampaign).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe("Há variações sem um campo da mensagem original. Corrija ou remova antes de continuar.");
  });

  it("bloqueia o salvamento quando as variações são de outra versão da mensagem", async () => {
    await openStage2();
    await generateFive();
    await type(messageField(), "Olá {{nome}}, aço por R$ 12.");
    await click("Salvar rascunho");
    expect(api.apiUpdateCampaign).not.toHaveBeenCalled();
    expect(container.textContent).toContain("As variações foram geradas a partir de outra versão da mensagem. Gere novamente ou remova as variações antes de continuar.");
  });

  it("permite salvar uma mensagem editada quando todas as variações foram removidas", async () => {
    await openStage2();
    await generateFive();
    await type(messageField(), "Olá {{nome}}, aço por R$ 12.");
    for (let index = 5; index >= 1; index -= 1) await click(`Remover variação ${index}`);
    await click("Salvar rascunho");
    expect(api.apiUpdateCampaign.mock.calls[0]![2].templates).toEqual(["Olá {{nome}}, aço por R$ 12."]);
  });

  it("considera as variações de um rascunho salvo atualizadas para a mensagem salva", async () => {
    await openStage2({ ...campaign, templates: [campaign.messageBody, fiveVariations[0]!] });
    expect(container.textContent).toContain("Variações (1 de 5)");
    expect(container.textContent).not.toContain("A mensagem original mudou");
    await click("Salvar rascunho");
    expect(api.apiUpdateCampaign.mock.calls[0]![2].templates).toEqual([campaign.messageBody, fiveVariations[0]]);
  });

  it("pede confirmação antes de regerar variações editadas, e só nesse caso", async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirm);
    await openStage2();
    await generateFive();
    api.apiGenerateMessageVariations.mockResolvedValueOnce(fiveVariations);
    await click("Regerar variações");
    expect(confirm).not.toHaveBeenCalled();
    expect(api.apiGenerateMessageVariations).toHaveBeenCalledTimes(2);
    await type(variationFields()[0]!, "Oi {{nome}}! Aço por R$ 10.");
    await click("Regerar variações");
    expect(confirm).toHaveBeenCalledWith("Regerar vai substituir as variações atuais, incluindo as suas edições. Continuar?");
    expect(api.apiGenerateMessageVariations).toHaveBeenCalledTimes(2);
    expect(variationFields()[0]!.value).toBe("Oi {{nome}}! Aço por R$ 10.");
  });
});
