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

/*
 * The weekly evaluation of the new agent's follow-ups, with the database. See avaliacao.ts for the method.
 * The unit is the customer: one customer (Villefer) may run the same agent in several workspaces, set by
 * `behaviorConfig.harness.cliente`. Their follow-ups are evaluated together and an approved rule goes to
 * every one of those agents. An agent without `cliente` is a customer of its own.
 */

const SEMANA_MS = 7 * 86_400_000;
const LIMITE_DE_CASOS = 60;

type Json = unknown;
type FindMany<T> = (args: unknown) => Promise<T[]>;

type EvaluationRecord = {
  id: string;
  clientKey: string;
  agents: Json;
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

type AgentRow = { id: string; workspaceId: string; name?: string; behaviorConfig: Json };

export type AgentEvaluationsPrismaLike = AiProviderSettingsPrismaLike & {
  aiAgent: {
    findMany(args: unknown): Promise<AgentRow[]>;
    update(args: unknown): Promise<unknown>;
  };
  aiAgentEvaluation: {
    findFirst(args: unknown): Promise<EvaluationRecord | null>;
    findMany: FindMany<EvaluationRecord>;
    create(args: unknown): Promise<EvaluationRecord>;
    update(args: unknown): Promise<EvaluationRecord>;
  };
  workspaceMirror?: { findMany(args: unknown): Promise<Array<{ workspaceId: string; name: string | null }>> };
  conversationFollowup: { findMany: FindMany<FollowupRow> };
  message: { findMany: FindMany<MessageRow>; findFirst(args: unknown): Promise<MessageRow | null> };
  aiKnowledgeSource: { findMany: FindMany<FonteDaBase> };
};

/** One of the customer's agents, in one of its workspaces. */
export type ClientAgentDto = { workspaceId: string; workspaceName: string | null; agentId: string; agentName: string; channels: number };

export type AgentEvaluationDto = {
  id: string;
  clientKey: string;
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

/** One customer on the product owner's evaluation page. */
export type EvaluationClientDto = {
  key: string;
  name: string;
  agents: ClientAgentDto[];
  rules: string[];
  latest: { periodStart: string; status: AgentEvaluationDto["status"] } | null;
  pendingProposals: number;
};

export class AgentEvaluationError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "HARNESS_OFF" | "PROPOSAL_DECIDED", message: string) {
    super(message);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);

/** "Villefer" → "villefer"; an agent with no customer is its own: "agente-<id>". */
export function chaveDoCliente(agent: { id: string }, config: HarnessConfig): string {
  const nome = config.cliente?.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return nome ? nome.slice(0, 60) : `agente-${agent.id}`;
}

type Member = { agent: AgentRow; config: HarnessConfig };
type Client = { key: string; name: string; members: Member[] };

/** The rules every agent of the customer follows: the union, in the order they were approved. */
function regrasDoCliente(client: Client) {
  return [...new Set(client.members.flatMap((member) => member.config.regrasDoFollowup ?? []))];
}

function toDto(record: EvaluationRecord, rules: string[]): AgentEvaluationDto {
  return {
    id: record.id,
    clientKey: record.clientKey,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    status: record.status === "ready" || record.status === "failed" ? record.status : "running",
    summary: isObject(record.summary) && isObject(record.summary.rotulos) ? record.summary as ResumoDaSemana : null,
    cases: asArray<CasoDaSemana>(record.cases),
    proposals: asArray<PropostaDeRegra>(record.proposals),
    rules,
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

  /** Every customer with the new agent on, its agents grouped by `cliente`. */
  async function loadClients(): Promise<Client[]> {
    const agents = await prisma.aiAgent.findMany({ select: { id: true, workspaceId: true, name: true, behaviorConfig: true } });
    const clients = new Map<string, Client>();
    for (const agent of agents) {
      const config = readHarnessConfig(agent.behaviorConfig);
      if (!config) continue;
      const key = chaveDoCliente(agent, config);
      const client = clients.get(key) ?? { key, name: config.cliente ?? agent.name ?? "Agente", members: [] };
      client.members.push({ agent, config });
      clients.set(key, client);
    }
    return [...clients.values()].map((client) => ({
      ...client,
      members: client.members.sort((a, b) => a.agent.workspaceId.localeCompare(b.agent.workspaceId) || a.agent.id.localeCompare(b.agent.id))
    }));
  }

  async function loadClient(key: string): Promise<Client> {
    const client = (await loadClients()).find((item) => item.key === key);
    if (!client) throw new AgentEvaluationError("NOT_FOUND", "Cliente sem o agente novo ligado.");
    return client;
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

  /** Each agent re-decides its own cases, with its workspace's model and knowledge. */
  async function refazedor(member: Member) {
    const { workspaceId, id: agentId } = member.agent;
    const settings = await resolveOpenAiCompatibleSettings(prisma, { workspaceId });
    const models = options.modelFactory
      ? options.modelFactory(settings, member.config.modelo)
      : (() => {
          const model = modeloDoHarness(settings, member.config.modelo);
          const analista = modeloDoAnalista(settings, member.config.modelo);
          return model && analista ? { model, analista } : null;
        })();
    if (!models) return null;
    const fontes = await prisma.aiKnowledgeSource.findMany({ where: { workspaceId, agentId, status: "ready" }, orderBy: [{ createdAt: "desc" }] });
    return { models, fontes };
  }

  async function executar(record: EvaluationRecord, client: Client) {
    const { periodStart, periodEnd } = record;
    const agora = clock();
    const decisoes = { mensagem: 0, lembrete: 0, nada: 0 };
    const conversas = new Map<string, { member: Member; mensagens: MensagemDaConversa[] }>();
    const casos: CasoDaSemana[] = [];
    for (const member of client.members) {
      const { workspaceId, id: agentId } = member.agent;
      const followups = (await prisma.conversationFollowup.findMany({
        where: { workspaceId, agentId, updatedAt: { gte: periodStart } },
        orderBy: { createdAt: "asc" }
      })).filter((followup) => {
        const em = decididoEm(followup);
        return doHarness(followup) && em && em >= periodStart && em < periodEnd;
      });
      for (const followup of followups) decisoes[decisaoDoFollowup(followup)] += 1;
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
        conversas.set(followup.id, { member, mensagens });
        casos.push({
          followupId: followup.id,
          conversationId: followup.conversationId,
          workspaceId,
          decididoEm: em.toISOString(),
          rotulo,
          rascunho: followup.draftBody,
          enviado: followup.finalBody,
          resposta: resposta?.body ?? null,
          ultimas: mensagens.filter((mensagem) => mensagem.autor !== "sistema").slice(-8).map((mensagem) => ({ autor: mensagem.autor, texto: (mensagem.texto ?? `[${mensagem.tipo ?? "mensagem"}]`).slice(0, 500) }))
        });
      }
    }

    const preparados = new Map<string, Awaited<ReturnType<typeof refazedor>>>();
    for (const member of client.members) preparados.set(member.agent.id, await refazedor(member));
    const revisor = [...preparados.values()].find((item) => item)?.models.analista;
    if (!revisor) throw new Error("O modelo de IA do workspace não está configurado.");

    const refazer = async (caso: CasoDaSemana, regras: string[]): Promise<DecisaoRefeita> => {
      const conversa = conversas.get(caso.followupId);
      const preparado = conversa ? preparados.get(conversa.member.agent.id) : null;
      if (!conversa || !preparado) throw new Error("O modelo de IA do workspace não está configurado.");
      const resultado = await seguirComHarness({
        config: conversa.member.config, model: preparado.models.model, analista: preparado.models.analista, jev: options.jev,
        fontes: preparado.fontes,
        mensagens: conversa.mensagens,
        sessionMetadata: null,
        agora: new Date(caso.decididoEm),
        regrasEmTeste: regras
      });
      return resultado.tipo === "lembrete_vendedor" ? "lembrete" : resultado.tipo;
    };
    return avaliarSemana({ casos, decisoes, revisor, regrasAtuais: regrasDoCliente(client), refazer });
  }

  /** Writes the customer's rules on every one of its agents. */
  async function gravarRegras(client: Client, regras: string[]) {
    for (const { agent } of client.members) {
      const behaviorConfig = isObject(agent.behaviorConfig) ? agent.behaviorConfig : {};
      const harness = isObject(behaviorConfig.harness) ? behaviorConfig.harness : {};
      await prisma.aiAgent.update({
        where: { workspaceId_id: { workspaceId: agent.workspaceId, id: agent.id } },
        data: { behaviorConfig: { ...behaviorConfig, harness: { ...harness, regrasDoFollowup: regras } } }
      });
    }
  }

  return {
    /** Runs (or returns) the customer's evaluation of the week that ends at `periodEnd`. */
    async runWeek(input: { clientKey: string; periodEnd?: Date; force?: boolean }): Promise<AgentEvaluationDto> {
      const client = await loadClient(input.clientKey);
      const regras = regrasDoCliente(client);
      const periodEnd = input.periodEnd ?? inicioDoSabado(clock());
      const periodStart = new Date(periodEnd.getTime() - SEMANA_MS);
      const existing = await prisma.aiAgentEvaluation.findFirst({ where: { clientKey: client.key, periodStart } });
      if (existing) {
        const idade = clock().getTime() - existing.updatedAt.getTime();
        // A run cut short by a restart stays "running"; after two hours it is tried again. A failure waits six.
        if (existing.status === "running" && idade < 2 * 3_600_000) return toDto(existing, regras);
        if (!input.force && (existing.status === "ready" || (existing.status === "failed" && idade < 6 * 3_600_000))) return toDto(existing, regras);
      }
      const agents = client.members.map(({ agent }) => ({ workspaceId: agent.workspaceId, agentId: agent.id }));
      let record = existing
        ? await prisma.aiAgentEvaluation.update({ where: { id: existing.id }, data: { status: "running", error: null, agents } })
        : await prisma.aiAgentEvaluation.create({ data: { clientKey: client.key, agents, periodStart, periodEnd, status: "running" } });
      try {
        const resultado = await executar(record, client);
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
      return toDto(record, regras);
    },

    async list(input: { clientKey: string }): Promise<AgentEvaluationDto[]> {
      const client = await loadClient(input.clientKey);
      const records = await prisma.aiAgentEvaluation.findMany({ where: { clientKey: client.key }, orderBy: { periodStart: "desc" }, take: 12 });
      return records.map((record) => toDto(record, regrasDoCliente(client)));
    },

    /** Approving a rule adds it to every agent of the customer; it takes effect on the next follow-up. */
    async decideProposal(input: { clientKey: string; evaluationId: string; proposalId: string; decision: "approve" | "reject" }): Promise<AgentEvaluationDto> {
      const client = await loadClient(input.clientKey);
      const record = await prisma.aiAgentEvaluation.findFirst({ where: { clientKey: client.key, id: input.evaluationId } });
      if (!record) throw new AgentEvaluationError("NOT_FOUND", "Avaliação não encontrada.");
      const proposals = asArray<PropostaDeRegra>(record.proposals);
      const proposal = proposals.find((item) => item.id === input.proposalId);
      if (!proposal) throw new AgentEvaluationError("NOT_FOUND", "Regra não encontrada.");
      if (proposal.status !== "pendente") throw new AgentEvaluationError("PROPOSAL_DECIDED", "Essa regra já foi decidida.");
      let regras = regrasDoCliente(client);
      if (input.decision === "approve") {
        regras = [...regras.filter((regra) => regra !== proposal.regra), proposal.regra];
        await gravarRegras(client, regras);
      }
      const updated = await prisma.aiAgentEvaluation.update({
        where: { id: record.id },
        data: {
          proposals: proposals.map((item) => item.id === proposal.id
            ? { ...item, status: input.decision === "approve" ? "aprovada" : "recusada", decididaEm: clock().toISOString() }
            : item)
        }
      });
      return toDto(updated, regras);
    },

    /** Removes an approved rule from every agent of the customer. */
    async removeRule(input: { clientKey: string; rule: string }): Promise<{ rules: string[] }> {
      const client = await loadClient(input.clientKey);
      const rules = regrasDoCliente(client).filter((regra) => regra !== input.rule);
      await gravarRegras(client, rules);
      return { rules };
    },

    /** Every customer with the new agent on, for the product owner's page. */
    async clients(): Promise<EvaluationClientDto[]> {
      const clients = await loadClients();
      if (!clients.length) return [];
      const workspaceIds = [...new Set(clients.flatMap((client) => client.members.map(({ agent }) => agent.workspaceId)))];
      const [mirrors, latest] = await Promise.all([
        prisma.workspaceMirror?.findMany({ where: { workspaceId: { in: workspaceIds } } }) ?? [],
        Promise.all(clients.map((client) => prisma.aiAgentEvaluation.findFirst({ where: { clientKey: client.key }, orderBy: [{ periodStart: "desc" }] })))
      ]);
      const names = new Map(mirrors.map((mirror) => [mirror.workspaceId, mirror.name]));
      return clients.map((client, index) => {
        const record = latest[index];
        const rules = regrasDoCliente(client);
        return {
          key: client.key,
          name: client.name,
          agents: client.members.map(({ agent, config }) => ({
            workspaceId: agent.workspaceId,
            workspaceName: names.get(agent.workspaceId) ?? null,
            agentId: agent.id,
            agentName: agent.name ?? "Agente",
            channels: config.canais.length
          })),
          rules,
          latest: record ? { periodStart: record.periodStart.toISOString(), status: toDto(record, rules).status } : null,
          pendingProposals: record ? asArray<PropostaDeRegra>(record.proposals).filter((proposal) => proposal.status === "pendente").length : 0
        };
      }).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    },

    /** The customers the Saturday job evaluates. */
    async clientKeys(): Promise<string[]> {
      return (await loadClients()).map((client) => client.key);
    }
  };
}

export type AgentEvaluationsService = ReturnType<typeof createAgentEvaluationsService>;

/** Every hour, from Saturday 06:00 in São Paulo, evaluates the week that just ended for each customer that has none yet. */
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
    for (const clientKey of await input.service.clientKeys()) {
      try {
        await input.service.runWeek({ clientKey, periodEnd: sabado });
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
