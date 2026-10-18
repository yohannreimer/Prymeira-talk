import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest } from "../../core/model.js";
import { reviewMessage } from "../../core/review.js";
import { comercial, decidirComercial, escolhaExplicita } from "./index.js";
import { readCommercialConfig, responderComercial } from "./producao.js";
import { fichaInicial, type ContextoComercial } from "./tipos.js";

const channel = "cc9311b4-abbe-43b4-813e-72d02f09d753";
const slot = { startsAt: "2026-10-20T13:00:00.000Z", label: "terça-feira, 20/10 às 10:00" };
const agenda = { durationMinutes: 15, timeZone: "America/Sao_Paulo", availableSlots: [slot], bookedMeeting: null };
const pedido: ContextoComercial = { empresa: "Empresa Exemplo", instrucoes: "Explique consultoria e agende uma conversa.", fontes: [], agenda };
const config = { agente: "comercial" as const, empresa: "Empresa Exemplo", canais: [channel] };
function model(intencao: string, reply: string, selection?: { startsAt: string; trecho: string }, requests: ModelRequest[] = []): ModelClient {
  let read = false;
  return { id: "fake", async complete(request) {
    requests.push(request);
    if (request.tools?.some(t => t.name === "responder")) return { content: null, toolCalls: [{ id: "w", name: "responder", arguments: JSON.stringify({ texto: reply }) }] };
    if (read) return { content: null, toolCalls: [] };
    read = true;
    return { content: null, toolCalls: [
      { id: "r", name: "registrar_contexto", arguments: JSON.stringify({ intencao, assunto: null, empresa: null, rotina: null }) },
      ...(selection ? [{ id: "s", name: "escolher_horario", arguments: JSON.stringify(selection) }] : [])
    ] };
  } };
}
const turn = (m: ModelClient, text: string, overrides: Partial<Parameters<typeof responderComercial>[0]> = {}) => responderComercial({
  config, model: m, instrucoes: pedido.instrucoes, fontes: [], agenda, mensagens: [],
  atual: { id: "m1", texto: text, em: "2026-10-19T12:00:00Z" }, sessionMetadata: {}, ...overrides
});
const decide = (intencao: ReturnType<typeof fichaInicial>["intencao"], extra = {}) => decidirComercial({ ficha: { ...fichaInicial(), intencao, ...extra }, pedido, triagem: null, evento: { tipo: "mensagem", texto: "mensagem" } });

describe("comercial reutilizável", () => {
  it("requires company and explicit channels, and ignores another workflow", () => {
    expect(readCommercialConfig({ harness: { ...config } })).toEqual(config);
    expect(readCommercialConfig({ harness: { agente: "atendimento" } })).toBeNull();
    expect(() => readCommercialConfig({ harness: { agente: "comercial", canais: [channel] } })).toThrow();
    expect(() => readCommercialConfig({ harness: { ...config, canais: [] } })).toThrow();
  });
  it("answers doubts without pushing the call and offers slots when asked", () => {
    expect(decide("duvida").tipo).toBe("responder_duvida");
    expect(decide("agendar").tipo).toBe("oferecer_horarios");
    expect(decide("humano").avisarHumano).toBeTruthy();
    expect(decide("recusar").tipo).toBe("encerrar");
  });
  it("invites once, after learning the routine, without mandatory qualification", () => {
    expect(decide("conhecer", { turnos: 1, rotina: "eu atendo tudo" }).tipo).toBe("convidar");
    expect(decide("conhecer", { turnos: 2, rotina: "eu atendo tudo", convites: 1 }).tipo).toBe("entender");
    expect(decide("agendar", { empresaDoContato: null, rotina: null }).tipo).toBe("oferecer_horarios");
  });
  it("hands over unavailable scheduling and preserves already booked meetings", async () => {
    const noCalendar = await turn(model("agendar", "Uma pessoa da empresa continua o agendamento por aqui."), "Quero agendar", { agenda: null });
    expect(noCalendar.handoff.required).toBe(true);
    expect(noCalendar.actions.some(a => a.type === "schedule_meeting")).toBe(false);
    expect(decidirComercial({ ficha: { ...fichaInicial(), intencao: "agendar" }, pedido: { ...pedido, agenda: { ...agenda, bookedMeeting: { eventId: "e", startsAt: slot.startsAt, label: slot.label, meetLink: null, htmlLink: null } } }, triagem: null, evento: { tipo: "mensagem", texto: "Já está agendado?" } }).tipo).toBe("ja_agendada");
  });
  it.each(["sim", "quero marcar", "terça", "10h", "quarta às 10h", "terça às 11h", "não posso terça às 10h", "tem terça às 10h?"])("does not book an ambiguous or mismatched choice: %s", async text => {
    const result = await turn(model("agendar", "Qual horário fica melhor?", { startsAt: slot.startsAt, trecho: text }), text);
    expect(result.actions.some(a => a.type === "schedule_meeting")).toBe(false);
  });
  it("only requests a reservation after a reviewed explicit choice", async () => {
    const result = await turn(model("agendar", "Vou reservar esse horário.", { startsAt: slot.startsAt, trecho: "terça às 10h" }), "terça às 10h");
    expect(result.actions).toContainEqual(expect.objectContaining({ type: "schedule_meeting", startsAt: slot.startsAt }));
    expect(result.reply).not.toMatch(/marcada|confirmada/);
    expect(result.ficha.horario).toBeNull();
  });
  it("rejects a forged quote and a slot outside availability", async () => {
    const forged = await turn(model("agendar", "Qual horário fica melhor?", { startsAt: slot.startsAt, trecho: "terça às 10h" }), "Quero marcar");
    const offGrid = await turn(model("agendar", "Qual horário fica melhor?", { startsAt: "2026-10-21T13:00:00Z", trecho: "quarta às 10h" }), "quarta às 10h");
    expect([...forged.actions, ...offGrid.actions].some(a => a.type === "schedule_meeting")).toBe(false);
  });
  it("does not reuse a stale choice or another workflow's record", async () => {
    for (const agente of ["comercial", "atendimento"]) {
      const result = await turn(model("duvida", "O plano é definido conforme a necessidade."), "Como funciona?", {
        sessionMetadata: { harness: { agente, ficha: { ...fichaInicial(), intencao: "agendar", horario: slot.startsAt } } }
      });
      expect(result.actions.some(a => a.type === "schedule_meeting")).toBe(false);
    }
  });
  it("keeps each company's prompt and approved sources inside that turn", async () => {
    const requests: ModelRequest[] = [];
    await turn(model("duvida", "Fazemos manutenção conforme o diagnóstico.", undefined, requests), "O que fazem?", {
      config: { ...config, empresa: "Oficina Aurora" }, instrucoes: "Manutenção de máquinas, atendente Rui.",
      fontes: [{ id: "f1", title: "Serviço", content: "Manutenção de máquinas.", metadata: { approvalStatus: "confirmed" } }, { id: "f2", title: "Rascunho", content: "GARANTIA_INEXISTENTE", metadata: { approvalStatus: "pending" } }]
    });
    const prompts = JSON.stringify(requests);
    expect(prompts).toContain("Oficina Aurora");
    expect(prompts).toContain("Manutenção de máquinas");
    expect(prompts).not.toMatch(/Villefer|Yohann|Prymeira|GARANTIA_INEXISTENTE|1\.000 kg/);
  });
  it("does not mistake a short time for a half-hour slot or ambiguous weekday", () => {
    expect(escolhaExplicita("terça 10h", "2026-10-20T13:30:00Z", agenda)).toBe(false);
    expect(escolhaExplicita("terça 10h", slot.startsAt, { ...agenda, availableSlots: [slot, { startsAt: "2026-10-27T13:00:00Z", label: "terça, 27/10 10h" }] })).toBe(false);
    expect(escolhaExplicita("20/10 às 10:00", slot.startsAt, agenda)).toBe(true);
  });
  it.each([
    ["Oi! 😊", "sem_emoji"],
    ["Vi teu formulário no site.", "sem_formulario_presumido"],
    ["Sua call está marcada.", "agenda_confirma"],
    ["O link é https://meet.google.com/abc-defg-hij", "sem_link_inventado"],
    ["Qual empresa? Quem atende?", "comercial_uma_pergunta"]
  ])("blocks unsafe writing: %s", async (texto, regra) => {
    const result = await reviewMessage({ texto, ficha: fichaInicial(), pedido, jogada: decide("conhecer"), historico: [], rules: comercial.regras, fichaTexto: "" });
    expect(result).toMatchObject({ ok: false, regra });
  });
  it("does not run silences as unsolicited outreach", () => {
    expect(decidirComercial({ ficha: fichaInicial(), pedido, triagem: null, evento: { tipo: "silencio", horasSemResposta: 2 } }).silencio).toBe(true);
  });
});
