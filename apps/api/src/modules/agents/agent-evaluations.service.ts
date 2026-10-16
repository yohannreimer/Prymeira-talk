import { resolveOpenAiCompatibleSettings, type AiProviderSettingsPrismaLike } from "./ai-provider-settings.js";
import {
  avaliarSemana,
  rotularFollowup,
  type CasoDaSemana,
  type DecisaoRefeita,
  type PropostaDeRegra,
  type ResumoDaSemana
} from "../harness/agentes/atendimento/avaliacao.js";
import {
  autorDaMensagem,
  modeloDoAnalista,
  modeloDoHarness,
  readHarnessConfig,
  seguirComHarness,
  type FonteDaBase,
  type HarnessConfig,
  type MensagemDaConversa
} from "../harness/agentes/atendimento/producao.js";
import type { JevClient } from "../harness/core/jev.js";
import type { ModelClient } from "../harness/core/model.js";
import type { OpenAiCompatibleSettings } from "./ai-provider-settings.js";

/* The weekly evaluation of the new agent's follow-ups, with the database. See avaliacao.ts for the method. */

const SEMANA_MS = 7 * 86_400_000;
const LIMITE_DE_CASOS = 60;

type Json = unknown;
type FindMany<T> = (args: unknown) => Promise<T[]>;

type EvaluationRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  periodStart: Date;
  periodEnd: Date;
  status: string;
  summary: Json;
  cases: Json;
  proposals: Json;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type FollowupRow = {
  id: string;
  conversationId: string;
  kind: string;
  status: string;
  decision: Json;
  draftBody: string | null;
  finalBody: string | null;
  sentByUserId: string | null;
  sentAt: Date | null;
  cancelledByUserId: string | null;
};

type MessageRow = {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  metadata?: Json;
  sentByUserId?: string | null;
  createdAt: Date;
};

export type AgentEvaluationsPrismaLike = AiProviderSettingsPrismaLike & {
  aiAgent: {
    findFirst(args: unknown): Promise<{ id: string; workspaceId: string; behaviorConfig: Json } | null>;
    findMany(args: unknown): Promise<Array<{ id: string; workspaceId: string; behaviorConfig: Json }>>;
    update(args: unknown): Promise<unknown>;
  };
  aiAgentEvaluation: {
    findFirst(args: unknown): Promise<EvaluationRecord | null>;
    findMany: FindMany<EvaluationRecord>;
    create(args: unknown): Promise<EvaluationRecord>;
    update(args: unknown): Promise<EvaluationRecord>;
  };
  conversationFollowup: { findMany: FindMany<FollowupRow> };
  message: { findMany: FindMany<MessageRow>; findFirst(args: unknown): Promise<MessageRow | null> };
  aiKnowledgeSource: { findMany: FindMany<FonteDaBase> };
};

export type AgentEvaluationDto = {
  id: string;
  agentId: string;
  periodStart: string;
  periodEnd: string;
  status: "running" | "ready" | "failed";
  summary: ResumoDaSemana | null;
  cases: CasoDaSemana[];
  proposals: PropostaDeRegra[];
  rules: string[];
  error: string | null;
  createdAt: string;
};

export class AgentEvaluationError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "HARNESS_OFF" | "PROPOSAL_DECIDED", message: string) {
    super(message);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);

function toDto(record: EvaluationRecord, config: HarnessConfig | null): AgentEvaluationDto {
  return {
    id: record.id,
    agentId: record.agentId,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    status: record.status === "ready" || record.status === "failed" ? record.status : "running",
    summary: isObject(record.summary) && isObject(record.summary.rotulos) ? record.summary as ResumoDaSemana : null,
    cases: asArray<CasoDaSemana>(record.cases),
    proposals: asArray<PropostaDeRegra>(record.proposals),
    rules: config?.regrasDoFollowup ?? [],
    error: record.error,
    createdAt: record.createdAt.toISOString()
  };
}

/** When the decision was made: the analysis time the runtime stores, if it is there. */
function decididoEm(followup: FollowupRow): Date | null {
  const analyzedAt = isObject(followup.decision) ? followup.decision.analyzedAt : null;
  const time = typeof analyzedAt === "string" ? Date.parse(analyzedAt) : NaN;
  return Number.isNaN(time) ? null : new Date(time);
}

const doHarness = (followup: FollowupRow) => isObject(followup.decision) && followup.decision.mode === "harness";

function decisaoDoFollowup(followup: FollowupRow): DecisaoRefeita {
  if (followup.kind === "seller_reminder") return "lembrete";
  return followup.status === "skipped" ? "nada" : "mensagem";
}

/** Saturday 00:00 in São Paulo (UTC-3, no daylight saving since 2019) at or before `now`. */
export function inicioDoSabado(now: Date): Date {
  const local = new Date(now.getTime() - 3 * 3_600_000);
  const diasDesdeSabado = (local.getUTCDay() + 1) % 7;
  const meiaNoite = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - diasDesdeSabado);
  return new Date(meiaNoite + 3 * 3_600_000);
}

export function createAgentEvaluationsService(options: {
  prisma: AgentEvaluationsPrismaLike;
  jev?: JevClient;
  /** Tests replace the models; production uses the workspace's chat model like the follow-up runtime. */
  modelFactory?: (settings: OpenAiCompatibleSettings, modelo?: string) => { model: ModelClient; analista: ModelClient } | null;
  now?: () => Date;
}) {
  const { prisma } = options;
  const clock = options.now ?? (() => new Date());

  async function loadAgent(workspaceId: string, agentId: string) {
    const agent = await prisma.aiAgent.findFirst({ where: { workspaceId, id: agentId } });
    if (!agent) throw new AgentEvaluationError("NOT_FOUND", "Agente não encontrado.");
    return { agent, config: readHarnessConfig(agent.behaviorConfig) };
  }

  async function mensagensAte(workspaceId: string, conversationId: string, ate: Date): Promise<MensagemDaConversa[]> {
    const rows = await prisma.message.findMany({
      where: { workspaceId, conversationId, hiddenByReset: false, createdAt: { lte: ate } },
      orderBy: { createdAt: "desc" },
      take: 80,
      select: { id: true, direction: true, type: true, body: true, metadata: true, sentByUserId: true, createdAt: true }
    });
    return rows.reverse().map((row) => ({
      id: row.id,
      autor: autorDaMensagem({ direction: row.direction, type: row.type, metadata: row.metadata, sentByUserId: row.sentByUserId }),
      tipo: row.type,
      texto: row.body,
      em: row.createdAt.toISOString()
    }));
  }

  async function executar(record: EvaluationRecord, config: HarnessConfig) {
    const { workspaceId, agentId, periodStart, periodEnd } = record;
    const agora = clock();
    const followups = (await prisma.conversationFollowup.findMany({
      where: { workspaceId, agentId, updatedAt: { gte: periodStart } },
      orderBy: { createdAt: "asc" }
    })).filter((followup) => {
      const em = decididoEm(followup);
      return doHarness(followup) && em && em >= periodStart && em < periodEnd;
    });
    const decisoes = { mensagem: 0, lembrete: 0, nada: 0 };
    for (const followup of followups) decisoes[decisaoDoFollowup(followup)] += 1;

    const conversas = new Map<string, MensagemDaConversa[]>();
    const casos: CasoDaSemana[] = [];
    for (const followup of followups) {
      if (casos.length >= LIMITE_DE_CASOS) break;
      const resposta = followup.status === "sent" && followup.sentAt && !followup.sentByUserId
        ? await prisma.message.findFirst({
            where: { workspaceId, conversationId: followup.conversationId, hiddenByReset: false, direction: "inbound", createdAt: { gt: followup.sentAt } },
            orderBy: { createdAt: "asc" }
          })
        : null;
      const rotulo = rotularFollowup({ ...followup, respostaEm: resposta?.createdAt ?? null }, agora);
      if (!rotulo) continue;
      const em = decididoEm(followup)!;
      const mensagens = await mensagensAte(workspaceId, followup.conversationId, em);
      conversas.set(followup.id, mensagens);
      casos.push({
        followupId: followup.id,
        conversationId: followup.conversationId,
        decididoEm: em.toISOString(),
        rotulo,
        rascunho: followup.draftBody,
        enviado: followup.finalBody,
        resposta: resposta?.body ?? null,
        ultimas: mensagens.filter((mensagem) => mensagem.autor !== "sistema").slice(-8).map((mensagem) => ({ autor: mensagem.autor, texto: (mensagem.texto ?? `[${mensagem.tipo ?? "mensagem"}]`).slice(0, 500) }))
      });
    }

    const settings = await resolveOpenAiCompatibleSettings(prisma, { workspaceId });
    const models = options.modelFactory
      ? options.modelFactory(settings, config.modelo)
      : (() => {
          const model = modeloDoHarness(settings, config.modelo);
          const analista = modeloDoAnalista(settings, config.modelo);
          return model && analista ? { model, analista } : null;
        })();
    if (!models) throw new Error("O modelo de IA do workspace não está configurado.");
    const fontes = await prisma.aiKnowledgeSource.findMany({ where: { workspaceId, agentId, status: "ready" }, orderBy: [{ createdAt: "desc" }] });

    const refazer = async (caso: CasoDaSemana, regras: string[]): Promise<DecisaoRefeita> => {
      const resultado = await seguirComHarness({
        config, model: models.model, analista: models.analista, jev: options.jev, fontes,
        mensagens: conversas.get(caso.followupId) ?? [],
        sessionMetadata: null,
        agora: new Date(caso.decididoEm),
        regrasEmTeste: regras
      });
      return resultado.tipo === "lembrete_vendedor" ? "lembrete" : resultado.tipo;
    };
    return avaliarSemana({ casos, decisoes, revisor: models.analista, regrasAtuais: config.regrasDoFollowup ?? [], refazer });
  }

  return {
    /** Runs (or returns) the evaluation of the week that ends at `periodEnd`. */
    async runWeek(input: { workspaceId: string; agentId: string; periodEnd?: Date; force?: boolean }): Promise<AgentEvaluationDto> {
      const { config } = await loadAgent(input.workspaceId, input.agentId);
      if (!config) throw new AgentEvaluationError("HARNESS_OFF", "O agente novo não está ligado neste agente.");
      const periodEnd = input.periodEnd ?? inicioDoSabado(clock());
      const periodStart = new Date(periodEnd.getTime() - SEMANA_MS);
      const existing = await prisma.aiAgentEvaluation.findFirst({ where: { workspaceId: input.workspaceId, agentId: input.agentId, periodStart } });
      if (existing && !input.force) {
        const idade = clock().getTime() - existing.updatedAt.getTime();
        // A run cut short by a restart stays "running"; after two hours it is tried again. A failure waits six.
        if (existing.status === "ready" || (existing.status === "running" && idade < 2 * 3_600_000) || (existing.status === "failed" && idade < 6 * 3_600_000)) {
          return toDto(existing, config);
        }
      }
      if (existing?.status === "running" && clock().getTime() - existing.updatedAt.getTime() < 2 * 3_600_000) return toDto(existing, config);
      let record = existing
        ? await prisma.aiAgentEvaluation.update({ where: { id: existing.id }, data: { status: "running", error: null } })
        : await prisma.aiAgentEvaluation.create({ data: { workspaceId: input.workspaceId, agentId: input.agentId, periodStart, periodEnd, status: "running" } });
      try {
        const resultado = await executar(record, config);
        record = await prisma.aiAgentEvaluation.update({
          where: { id: record.id },
          data: { status: "ready", summary: resultado.resumo, cases: resultado.casos, proposals: resultado.propostas, error: null }
        });
      } catch (error) {
        record = await prisma.aiAgentEvaluation.update({
          where: { id: record.id },
          data: { status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "Falha desconhecida." }
        });
      }
      return toDto(record, config);
    },

    async list(input: { workspaceId: string; agentId: string }): Promise<AgentEvaluationDto[]> {
      const { config } = await loadAgent(input.workspaceId, input.agentId);
      const records = await prisma.aiAgentEvaluation.findMany({
        where: { workspaceId: input.workspaceId, agentId: input.agentId },
        orderBy: { periodStart: "desc" },
        take: 12
      });
      return records.map((record) => toDto(record, config));
    },

    /** Approving a rule adds it to the agent's follow-up rules; it takes effect on the next follow-up. */
    async decideProposal(input: { workspaceId: string; agentId: string; evaluationId: string; proposalId: string; decision: "approve" | "reject" }): Promise<AgentEvaluationDto> {
      const { agent, config } = await loadAgent(input.workspaceId, input.agentId);
      const record = await prisma.aiAgentEvaluation.findFirst({ where: { workspaceId: input.workspaceId, agentId: input.agentId, id: input.evaluationId } });
      if (!record) throw new AgentEvaluationError("NOT_FOUND", "Avaliação não encontrada.");
      const proposals = asArray<PropostaDeRegra>(record.proposals);
      const proposal = proposals.find((item) => item.id === input.proposalId);
      if (!proposal) throw new AgentEvaluationError("NOT_FOUND", "Regra não encontrada.");
      if (proposal.status !== "pendente") throw new AgentEvaluationError("PROPOSAL_DECIDED", "Essa regra já foi decidida.");
      let regras = config?.regrasDoFollowup ?? [];
      if (input.decision === "approve") {
        if (!config) throw new AgentEvaluationError("HARNESS_OFF", "O agente novo não está ligado neste agente.");
        const behaviorConfig = isObject(agent.behaviorConfig) ? agent.behaviorConfig : {};
        const harness = isObject(behaviorConfig.harness) ? behaviorConfig.harness : {};
        regras = [...regras.filter((regra) => regra !== proposal.regra), proposal.regra];
        await prisma.aiAgent.update({
          where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.agentId } },
          data: { behaviorConfig: { ...behaviorConfig, harness: { ...harness, regrasDoFollowup: regras } } }
        });
      }
      const updated = await prisma.aiAgentEvaluation.update({
        where: { id: record.id },
        data: {
          proposals: proposals.map((item) => item.id === proposal.id
            ? { ...item, status: input.decision === "approve" ? "aprovada" : "recusada", decididaEm: clock().toISOString() }
            : item)
        }
      });
      return toDto(updated, config ? { ...config, regrasDoFollowup: regras } : null);
    },

    /** Removes an approved rule from the agent. */
    async removeRule(input: { workspaceId: string; agentId: string; rule: string }): Promise<{ rules: string[] }> {
      const { agent, config } = await loadAgent(input.workspaceId, input.agentId);
      if (!config) throw new AgentEvaluationError("HARNESS_OFF", "O agente novo não está ligado neste agente.");
      const behaviorConfig = isObject(agent.behaviorConfig) ? agent.behaviorConfig : {};
      const harness = isObject(behaviorConfig.harness) ? behaviorConfig.harness : {};
      const rules = (config.regrasDoFollowup ?? []).filter((regra) => regra !== input.rule);
      await prisma.aiAgent.update({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.agentId } },
        data: { behaviorConfig: { ...behaviorConfig, harness: { ...harness, regrasDoFollowup: rules } } }
      });
      return { rules };
    },

    /** The agents with the new attendance agent on, which the Saturday job evaluates. */
    async harnessAgents(): Promise<Array<{ workspaceId: string; agentId: string }>> {
      const agents = await prisma.aiAgent.findMany({ select: { id: true, workspaceId: true, behaviorConfig: true } });
      return agents.filter((agent) => readHarnessConfig(agent.behaviorConfig)).map((agent) => ({ workspaceId: agent.workspaceId, agentId: agent.id }));
    }
  };
}

export type AgentEvaluationsService = ReturnType<typeof createAgentEvaluationsService>;

/** Every hour, from Saturday 06:00 in São Paulo, evaluates the week that just ended for each agent that has none yet. */
export function createAgentEvaluationsScheduler(input: {
  service: AgentEvaluationsService;
  intervalMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}) {
  const clock = input.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<void> | null = null;

  async function tick() {
    const now = clock();
    const sabado = inicioDoSabado(now);
    if (now.getTime() - sabado.getTime() < 6 * 3_600_000) return;
    for (const agent of await input.service.harnessAgents()) {
      try {
        await input.service.runWeek({ ...agent, periodEnd: sabado });
      } catch (error) {
        input.onError?.(error);
      }
    }
  }
  function poll() {
    if (active) return;
    active = tick().catch((error) => input.onError?.(error)).finally(() => { active = null; });
  }
  return {
    start() {
      if (timer) return;
      timer = setInterval(poll, input.intervalMs ?? 3_600_000);
      timer.unref?.();
      poll();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    },
    runOnce: tick
  };
}
