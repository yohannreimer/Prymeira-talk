// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAgentDto, CampaignDto } from "../app/api";
import { SettingsPage } from "./settings/SettingsPage";
import { AgentsPage } from "./assistant/AgentsPage";
import { GuidedCampaignEditor, SAFE_CADENCE } from "./campaigns/GuidedCampaignEditor";
import { emptyAgentFollowupConfig, validateAgentFollowupConfig } from "./assistant/AgentFollowupConfigEditor";

const mock = vi.hoisted(() => ({ getToken: vi.fn(async () => "token"), settings: vi.fn(), user: vi.fn(),
  updateSettings: vi.fn(), updateBehavior: vi.fn(), modules: vi.fn(), agents: vi.fn(), createAgent: vi.fn(), updateAgent: vi.fn(), updateCampaign: vi.fn(), preview: vi.fn(), progress: vi.fn(), recipients: vi.fn() }));
vi.mock("../app/auth", () => ({ useTalkAuth: () => ({ getToken: mock.getToken }) }));
vi.mock("../app/api", async (load) => ({ ...await load<typeof import("../app/api")>(),
  apiGetSettings: mock.settings, apiGetCurrentTalkUser: mock.user, apiUpdateModules: mock.modules,
  apiUpdateSettings: mock.updateSettings, apiUpdateAgentBehavior: mock.updateBehavior,
  apiGetAgents: mock.agents, apiCreateAgent: mock.createAgent, apiUpdateAgent: mock.updateAgent,
  apiGetTags: vi.fn(async () => []), apiGetAuditLog: vi.fn(async () => []),
  apiGetAgentKnowledge: vi.fn(async () => []), apiGetAgentImprovements: vi.fn(async () => []),
  apiUpdateCampaign: mock.updateCampaign, apiPreviewCampaignAudience: mock.preview,
  apiGetCampaignProgress: mock.progress, apiGetCampaignRecipients: mock.recipients
}));
const settings = { workspace: { workspaceId: "workspace" }, integrations: [], behavior: { agentReplyWaitSeconds: 40 }, modules: { campaignProspecting: true } };
const agent: AiAgentDto = { id: "agent", workspaceId: "workspace", name: "Qualificador", type: "prospecting", status: "active",
  providerMode: "prymeira_managed", provider: "simulated", model: "test", description: null,
  systemPrompt: "Prompt personalizado", behaviorConfig: {}, handoffConfig: {}, limitsConfig: {}, allowedActions: [], allowedTags: [],
  createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" };
const campaign: CampaignDto = { id: "campaign", workspaceId: "workspace", name: "Oferta", status: "draft",
  audience: { type: "imported", rows: [{ phone: "5547999999999", fields: {} }] }, messageBody: "Olá", templates: ["Olá"],
  fallbackName: "cliente", cadence: SAFE_CADENCE, scheduledAt: null, mode: "simulated", createdAt: agent.createdAt, updatedAt: agent.updatedAt };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.settings.mockResolvedValue(settings); mock.user.mockResolvedValue({ role: "owner" });
  mock.updateSettings.mockResolvedValue(settings); mock.updateBehavior.mockResolvedValue(settings);
  mock.modules.mockImplementation(async (_token, modules) => ({ ...settings, modules }));
  mock.agents.mockResolvedValue([agent]); mock.updateCampaign.mockImplementation(async (_token, _id, body) => ({ ...campaign, ...body }));
  mock.createAgent.mockImplementation(async (_token, body) => ({ ...agent, ...body }));
  mock.updateAgent.mockImplementation(async (_token, _id, body) => ({ ...agent, ...body }));
  mock.progress.mockResolvedValue({ status: "completed", total: 1, sent: 0, pending: 0, skipped: 1, failed: 0, uncertain: 0 });
  mock.recipients.mockResolvedValue([{ id: "recipient", status: "skipped_in_service", contactName: "Contato ocupado", contactPhone: "5547999999999", skipReason: "Contato já está em atendimento ou reservado por outra campanha." }]);
  mock.preview.mockResolvedValue({ eligible: [], excluded: [], selectedCount: 1, unresolvedVariables: [], audienceHash: "hash", revision: "revision" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function mount(element: React.ReactNode) { await act(async () => root.render(element)); }
function button(text: string) { return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text))!; }
function field(label: string) { return [...container.querySelectorAll("label")].find((item) => item.textContent?.includes(label))!.querySelector("input, select, textarea") as HTMLInputElement; }
async function click(element: Element) { await act(async () => (element as HTMLElement).click()); }
async function change(element: HTMLInputElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}
async function submitForm(id: string) {
  await act(async () => container.querySelector(id)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
async function editor(value: CampaignDto = campaign) {
  await mount(<GuidedCampaignEditor campaign={value} boards={[]} channels={[{ id: "channel", displayName: "Geral" } as never]}
    getToken={mock.getToken} parseFile={async () => []} onSaved={vi.fn()} onBack={vi.fn()} onMeta={vi.fn()} />);
  await click(button("Continuar para mensagem"));
}

describe("prospecção nos fluxos de configuração", () => {
  it("persists the module for an owner and displays server state", async () => {
    await mount(<SettingsPage />);
    const toggle = field("Ativar módulo IA para disparo");
    expect(toggle.checked).toBe(true); expect(toggle.disabled).toBe(false);
    await click(toggle);
    expect(mock.modules).toHaveBeenCalledWith(mock.getToken, { campaignProspecting: false });
    expect(toggle.checked).toBe(false);
    expect(container.textContent).toContain("encaminhadas para o time");
  });
  it.each([
    { save: "provider", initialEnabled: false }, { save: "provider", initialEnabled: true },
    { save: "behavior", initialEnabled: false }, { save: "behavior", initialEnabled: true }
  ])("preserves the module after a stale $save response (initial enabled: $initialEnabled)", async ({ save, initialEnabled }) => {
    const initial = { ...settings, modules: { campaignProspecting: initialEnabled } };
    const unrelatedSave = deferred<typeof initial>();
    const moduleSave = deferred<typeof initial>();
    mock.settings.mockResolvedValue(initial);
    mock.updateSettings.mockReturnValue(unrelatedSave.promise); mock.updateBehavior.mockReturnValue(unrelatedSave.promise);
    mock.modules.mockReturnValue(moduleSave.promise);
    await mount(<SettingsPage />);
    if (save === "behavior") await change(field("Tempo de espera após a última mensagem"), "25");
    await submitForm(save === "provider" ? "#settings-ai" : "#settings-agent-behavior");
    expect(save === "provider" ? mock.updateSettings : mock.updateBehavior).toHaveBeenCalledOnce();
    const toggle = field("Ativar módulo IA para disparo");
    await click(toggle);
    expect(toggle.disabled).toBe(true);
    await act(async () => moduleSave.resolve({ ...initial, modules: { campaignProspecting: !initialEnabled } }));
    expect(toggle.checked).toBe(!initialEnabled);
    await act(async () => unrelatedSave.resolve({ ...initial, behavior: { agentReplyWaitSeconds: 25 } }));
    expect(toggle.checked).toBe(!initialEnabled); expect(toggle.disabled).toBe(false);
    expect(mock.modules).toHaveBeenCalledWith(mock.getToken, { campaignProspecting: !initialEnabled });
    if (save === "behavior") expect(field("Tempo de espera após a última mensagem").value).toBe("25");
  });
  it("retains the saved module and shows an error when a module save fails", async () => {
    mock.modules.mockRejectedValue(new Error("Não foi possível salvar os módulos."));
    await mount(<SettingsPage />); await click(field("Ativar módulo IA para disparo"));
    expect(field("Ativar módulo IA para disparo").checked).toBe(true);
    expect(field("Ativar módulo IA para disparo").disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Não foi possível salvar os módulos");
  });
  it("keeps older module settings off and nonowners read-only", async () => {
    mock.settings.mockResolvedValue({ ...settings, modules: undefined }); mock.user.mockResolvedValue({ role: "manager" });
    await mount(<SettingsPage />);
    expect(field("Ativar módulo IA para disparo").checked).toBe(false);
    expect(field("Ativar módulo IA para disparo").disabled).toBe(true);
    await click(field("Ativar módulo IA para disparo")); expect(mock.modules).not.toHaveBeenCalled();
  });
  it("requires a handoff goal and saves a prospecting agent with an empty plan", async () => {
    mock.agents.mockResolvedValue([]); await mount(<AgentsPage />);
    await change(field("Tipo de agente"), "prospecting");
    expect(field("Prompt do sistema").value).toContain("prospecção");
    const form = field("Nome").closest("form")!;
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mock.createAgent).not.toHaveBeenCalled(); expect(container.textContent).toContain("Preencha Quando passar para o humano");
    await change(field("Quando passar para o humano"), "Quando pedir uma proposta");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mock.createAgent).toHaveBeenCalledWith(mock.getToken, expect.objectContaining({ type: "prospecting",
      prospectingGoal: "Quando pedir uma proposta", followupConfig: emptyAgentFollowupConfig() }));
  });
  it("defaults legacy agents to attendance and preserves customized prompts on type changes", async () => {
    mock.agents.mockResolvedValue([{ ...agent, type: undefined }]); await mount(<AgentsPage />);
    expect(field("Tipo de agente").value).toBe("attendance"); await change(field("Tipo de agente"), "prospecting");
    expect(field("Prompt do sistema").value).toBe("Prompt personalizado");
  });
  it("preserves stored closing data while editing other fields and caps steps at ten", async () => {
    const followup = { ...emptyAgentFollowupConfig(), closeAfterBusinessMinutes: 900,
      steps: Array.from({ length: 10 }, (_, index) => ({ afterBusinessMinutes: (index + 1) * 60, instruction: "Retomar" })) };
    mock.agents.mockResolvedValue([{ ...agent, handoffConfig: { prospectingGoal: "Qualificar" }, behaviorConfig: { followup } }]);
    await mount(<AgentsPage />);
    expect(button("Adicionar retomada").disabled).toBe(true);
    expect(container.textContent).not.toContain("Fechar automaticamente");
    await change(field("Nome"), "Nome atualizado");
    await act(async () => field("Nome").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mock.updateAgent).toHaveBeenCalledWith(mock.getToken, "agent", expect.objectContaining({ name: "Nome atualizado", followupConfig: followup }));
  });
  it("validates increasing cumulative steps, instructions, business hours and timezone", () => {
    const valid = { ...emptyAgentFollowupConfig(), steps: [{ afterBusinessMinutes: 60, instruction: "Retomar" }, { afterBusinessMinutes: 120, instruction: "Relembrar" }] };
    expect(validateAgentFollowupConfig(valid)).toBeNull();
    expect(validateAgentFollowupConfig({ ...valid, steps: Array.from({ length: 11 }, (_, index) => ({ afterBusinessMinutes: index + 1, instruction: "Retomar" })) })).toContain("10");
    expect(validateAgentFollowupConfig({ ...valid, steps: [valid.steps[0], valid.steps[0]] })).toContain("crescentes");
    expect(validateAgentFollowupConfig({ ...valid, steps: [{ afterBusinessMinutes: 60, instruction: " " }] })).toContain("instrução");
    expect(validateAgentFollowupConfig({ ...valid, businessHours: { start: "18:00", end: "08:00" } })).toContain("posterior");
    expect(validateAgentFollowupConfig({ ...valid, timeZone: "Invalid/Zone" })).toContain("fuso");
  });
});

describe("prospecção no disparo guiado", () => {
  it("disables the toggle while the workspace module is off", async () => {
    mock.settings.mockResolvedValue({ ...settings, modules: { campaignProspecting: false } }); await editor();
    expect(field("Acompanhar respostas com IA").disabled).toBe(true);
    expect(container.querySelector('a[href="?module=ajustes#settings-modules"]')).not.toBeNull();
  });
  it("requires an active prospecting agent, filters the options and saves offer context", async () => {
    mock.agents.mockResolvedValue([agent, { ...agent, id: "attendance", name: "Atendente", type: "attendance" }, { ...agent, id: "inactive", name: "Inativo", status: "inactive" }]);
    await editor(); await click(field("Acompanhar respostas com IA")); await click(button("Verificar destinatários"));
    expect(mock.updateCampaign).not.toHaveBeenCalled(); expect(container.textContent).toContain("Escolha um agente ativo de Prospecção");
    const select = field("Agente de Prospecção");
    expect(select.textContent).toContain("Qualificador"); expect(select.textContent).not.toContain("Atendente"); expect(select.textContent).not.toContain("Inativo");
    await change(select, "agent"); await change(field("Contexto da oferta"), "Oferta especial"); await click(button("Verificar destinatários"));
    expect(mock.updateCampaign).toHaveBeenCalledWith(mock.getToken, "campaign", expect.objectContaining({ prospectingAgentId: "agent", prospectingContext: "Oferta especial" }));
    expect(container.textContent).toContain("Agente responsável"); expect(container.textContent).toContain("Oferta especial");
  });
  it("shows active binding as read-only and explains skipped contacts", async () => {
    await mount(<GuidedCampaignEditor campaign={{ ...campaign, status: "completed", prospectingAgentId: "agent", prospectingContext: "Oferta ativa" }}
      boards={[]} channels={[]} getToken={mock.getToken} parseFile={async () => []} onSaved={vi.fn()} onBack={vi.fn()} onMeta={vi.fn()} />);
    expect(container.textContent).toContain("Qualificador"); expect(container.textContent).toContain("Oferta ativa");
    expect(container.querySelector("select")).toBeNull(); expect(container.textContent).toContain("Contatos ignorados");
    expect(container.textContent).toContain("Contato ocupado"); expect(container.textContent).toContain("reservado por outra campanha");
    expect(container.textContent).toContain("não encerra as conversas em andamento");
  });
  it("restores draft binding and clears both fields when disabled", async () => {
    await editor({ ...campaign, prospectingAgentId: "agent", prospectingContext: "Oferta salva" });
    expect(field("Acompanhar respostas com IA").checked).toBe(true);
    expect(field("Agente de Prospecção").value).toBe("agent"); expect(field("Contexto da oferta").value).toBe("Oferta salva");
    await click(field("Acompanhar respostas com IA")); await click(button("Salvar rascunho"));
    expect(mock.updateCampaign).toHaveBeenCalledWith(mock.getToken, "campaign", expect.objectContaining({ prospectingAgentId: null, prospectingContext: null }));
  });
});
