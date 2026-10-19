import { z } from "zod";
import type { MeetingAvailability } from "../../../agents/meeting-scheduler.js";
import type { ModelClient } from "../../core/model.js";
import type { JevClient } from "../../core/jev.js";
import { createJevJudge } from "../../core/review.js";
import { createTriage } from "../../core/triage.js";
import { runTurn } from "../../core/runner.js";
import type { HarnessMessage, TraceStep } from "../../core/types.js";
import { comercial } from "./index.js";
import { fichaInicial, type FichaComercial } from "./tipos.js";

const configSchema = z.object({ agente: z.literal("comercial"), empresa: z.string().trim().min(1), canais: z.array(z.string().trim().min(1)).min(1), modelo: z.string().trim().min(1).optional() });
export type ConfigComercial = z.infer<typeof configSchema>;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function readCommercialConfig(behavior: unknown): ConfigComercial | null {
  const value = record(behavior) ? behavior.harness : null;
  if (!record(value) || value.agente !== "comercial") return null;
  // A malformed commercial config must not silently fall back to a different engine.
  return configSchema.parse(value);
}

const fichaSchema = z.object({
  empresaDoContato: z.string().nullable(), rotina: z.string().nullable(),
  intencao: z.enum(["conhecer", "duvida", "agendar", "recusar", "humano"]), assunto: z.string().nullable(),
  horario: z.string().nullable(), turnos: z.number().int().nonnegative(), convites: z.number().int().nonnegative(), encerrada: z.boolean()
});

export type MensagemComercial = { id: string; autor: HarnessMessage["autor"]; tipo: string | null; texto: string | null; em: string | null };
export type SaidaComercial = {
  silencio: boolean; reply: string | null; actions: Array<Record<string, unknown> & { type: string }>;
  handoff: { required: boolean; reason: string | null }; ficha: FichaComercial; jogada: string | null; trace: TraceStep[];
};

export async function responderComercial(input: {
  config: ConfigComercial; model: ModelClient; jev?: JevClient; instrucoes: string;
  fontes: Array<{ id: string; title: string; content: string | null; metadata?: unknown }>;
  agenda: MeetingAvailability | null; mensagens: MensagemComercial[];
  atual: { id: string; texto: string; em: string }; sessionMetadata: unknown;
}): Promise<SaidaComercial> {
  const metadata = input.sessionMetadata;
  const saved = record(metadata) && record(metadata.harness) && metadata.harness.agente === "comercial" ? fichaSchema.safeParse(metadata.harness.ficha) : null;
  const ficha = saved?.success ? saved.data : fichaInicial();
  // Intention and slot belong to this message, never to the previous turn or a different agent's record.
  const novaFicha = { ...ficha, intencao: "conhecer" as const, assunto: null, horario: null };
  const index = input.mensagens.findIndex(m => m.id === input.atual.id);
  const mensagens = index < 0 ? [...input.mensagens, { ...input.atual, autor: "contato" as const, tipo: "text", texto: input.atual.texto }] : input.mensagens.slice(0, index + 1);
  const historico: HarnessMessage[] = mensagens.map(m => ({ autor: m.autor, texto: m.id === input.atual.id ? input.atual.texto : m.texto ?? `[${m.tipo ?? "mensagem"}]`, em: m.em ?? input.atual.em }));
  let inicio = historico.length - 1;
  while (inicio > 0 && historico[inicio - 1]!.autor === "contato") inicio--;
  const texto = historico.slice(inicio).map(m => m.texto).join("\n");
  const fontes = input.fontes.filter(f => record(f.metadata) && ["confirmed", "behavioral"].includes(String(f.metadata.approvalStatus))).map(({ id, title, content }) => ({ id, title, content }));
  const resultado = await runTurn(comercial, {
    model: input.model, triage: createTriage({ jev: input.jev }),
    ...(input.jev ? { judge: createJevJudge(input.jev), judgeFailClosed: true } : {})
  }, { ficha: novaFicha, pedido: { empresa: input.config.empresa, instrucoes: input.instrucoes, fontes, agenda: input.agenda }, historico, evento: { tipo: "mensagem", texto } });
  const actions: SaidaComercial["actions"] = [];
  if (resultado.humano) actions.push({ type: "create_internal_note", body: `${resultado.humano.motivo}\n${resultado.humano.resumo}` }, { type: "request_handoff", reason: resultado.humano.motivo });
  // Only a reviewed reply with a valid, still-offered selection can request a reservation.
  const requested = resultado.jogada?.dados?.startsAt;
  if (resultado.enviar && !resultado.humano && resultado.jogada?.tipo === "solicitar_reserva" && typeof requested === "string" && input.agenda?.availableSlots.some(s => s.startsAt === requested)) {
    actions.push({ type: "schedule_meeting", startsAt: requested, notes: `Empresa: ${resultado.ficha.empresaDoContato ?? "não informada"}. Rotina: ${resultado.ficha.rotina ?? "não informada"}.` });
  }
  return { silencio: !resultado.enviar && !resultado.humano, reply: resultado.enviar ?? (resultado.humano ? comercial.avisoDeRepasse! : null), actions,
    handoff: { required: Boolean(resultado.humano), reason: resultado.humano?.motivo ?? null }, ficha: resultado.ficha, jogada: resultado.jogada?.tipo ?? null, trace: resultado.trace };
}
