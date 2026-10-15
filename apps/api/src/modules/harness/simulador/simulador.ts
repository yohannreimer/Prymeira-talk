import type { ModelClient } from "../core/model.js";
import { renderTranscript, runTurn, type RunnerDeps } from "../core/runner.js";
import type { AgentDefinition, HarnessMessage, TurnResult } from "../core/types.js";

/**
 * The other side of the conversation. A scripted persona answers from code (tests, exact edge cases);
 * an LLM persona plays a role with hidden facts (the real evaluation).
 */
export type Persona =
  | { tipo: "roteiro"; responder: (input: { historico: HarnessMessage[]; vez: number }) => string | null }
  | { tipo: "llm"; papel: string; segredos: string };

export type Scenario<Ficha, Pedido> = {
  id: string;
  titulo: string;
  pedido: Pedido;
  persona: Persona;
  /**
   * A conversation that already happened (a real one, for follow-up scenarios). The run starts from it
   * instead of an opening message; a persona that stays silent then exercises the silence events.
   */
  historicoInicial?: HarnessMessage[];
  /** Contact messages before the harness stops the conversation. */
  maxTrocas?: number;
  /** Needs a real model (numbers spelled out, an LLM persona): left out of the offline test run. */
  exigeModelo?: boolean;
  verificar: (run: ScenarioRun<Ficha, Pedido>) => Check[];
};

export type Check = { nome: string; ok: boolean; detalhe?: string };

export type ScenarioRun<Ficha, Pedido> = {
  pedido: Pedido;
  ficha: Ficha;
  historico: HarnessMessage[];
  turnos: Array<{ evento: string; resultado: TurnResult<Ficha> }>;
  humano: { motivo: string; resumo: string } | null;
  erro: string | null;
};

const SILENCE = "[SILENCIO]";

export async function runScenario<Ficha, Pedido>(input: {
  agent: AgentDefinition<Ficha, Pedido>;
  deps: RunnerDeps;
  scenario: Scenario<Ficha, Pedido>;
  /** Plays LLM personas. Not needed for scripted ones. */
  fornecedorModel?: ModelClient;
}): Promise<ScenarioRun<Ficha, Pedido>> {
  const { agent, deps, scenario } = input;
  const run: ScenarioRun<Ficha, Pedido> = {
    pedido: scenario.pedido,
    ficha: agent.fichaInicial(scenario.pedido),
    historico: [...(scenario.historicoInicial ?? [])],
    turnos: [],
    humano: null,
    erro: null
  };
  const clock = new SimulatedClock();
  const step = async (evento: Parameters<typeof runTurn>[2]["evento"]) => {
    const resultado = await runTurn(agent, deps, { ficha: run.ficha, pedido: run.pedido, historico: run.historico, evento });
    run.ficha = resultado.ficha;
    run.turnos.push({ evento: evento.tipo === "mensagem" ? `contato: ${evento.texto}` : evento.tipo, resultado });
    if (resultado.enviar) run.historico.push({ autor: "agente", texto: resultado.enviar, em: clock.tick() });
    if (resultado.humano) run.humano = resultado.humano;
    return resultado;
  };

  try {
    if (!scenario.historicoInicial?.length) await step({ tipo: "abertura" });
    let silencesInARow = 0;
    const maxTrocas = scenario.maxTrocas ?? 10;
    for (let vez = 0; vez < maxTrocas && !run.humano; vez += 1) {
      const reply = await personaReply(scenario.persona, run.historico, vez, input.fornecedorModel);
      if (reply === null) {
        silencesInARow += 1;
        if (silencesInARow > 3) break;
        const resultado = await step({ tipo: "silencio", horasSemResposta: 24 * silencesInARow });
        if (!resultado.enviar) break;
        continue;
      }
      silencesInARow = 0;
      run.historico.push({ autor: "contato", texto: reply, em: clock.tick() });
      await step({ tipo: "mensagem", texto: reply });
    }
  } catch (error) {
    run.erro = error instanceof Error ? error.message : String(error);
  }
  return run;
}

async function personaReply(persona: Persona, historico: HarnessMessage[], vez: number, model?: ModelClient): Promise<string | null> {
  if (persona.tipo === "roteiro") return persona.responder({ historico, vez });
  if (!model) throw new Error("SIMULATOR_NEEDS_SUPPLIER_MODEL");
  const response = await model.complete({
    messages: [
      {
        role: "system",
        content: [
          "Você está num teste. Você faz o papel de uma pessoa (ou sistema) do outro lado de uma conversa de WhatsApp com uma empresa. Escreva só a PRÓXIMA mensagem desse personagem, em português do Brasil, do jeito que ele escreveria no WhatsApp (curto, informal, pode ter erro de digitação).",
          `Se o personagem não responderia agora, escreva exatamente ${SILENCE}.`,
          "Se a conversa já terminou para o personagem, escreva exatamente [FIM].",
          "",
          "# Seu papel",
          persona.papel,
          "",
          "# O que só você sabe (use quando fizer sentido; nunca diga que é um teste)",
          persona.segredos
        ].join("\n")
      },
      { role: "user", content: `Conversa até agora:\n${renderTranscript(historico) || "(vazia)"}\n\nSua próxima mensagem:` }
    ]
  });
  const text = (response.content ?? "").trim();
  if (!text || text.includes("[FIM]")) return null;
  if (text.includes(SILENCE)) return null;
  return text;
}

class SimulatedClock {
  private time = Date.parse("2026-10-15T13:00:00.000Z");
  tick() {
    this.time += 4 * 60_000;
    return new Date(this.time).toISOString();
  }
}

export type ScenarioScore = {
  id: string;
  titulo: string;
  tentativas: number;
  acertos: number;
  /** Passed every attempt: the reliability number that matters (τ-bench "pass^k"). */
  passouTodas: boolean;
  falhas: Array<{ tentativa: number; checks: Check[]; transcript: string; erro: string | null }>;
};

export type SuiteReport = { agente: string; modelo: string; k: number; cenarios: ScenarioScore[]; passK: number; passAt1: number };

/** Runs every scenario k times. A scenario counts only if all k runs pass all checks. */
export async function runSuite<Ficha, Pedido>(input: {
  agent: AgentDefinition<Ficha, Pedido>;
  deps: () => RunnerDeps;
  scenarios: Scenario<Ficha, Pedido>[];
  k: number;
  fornecedorModel?: ModelClient;
  onProgress?: (line: string) => void;
}): Promise<SuiteReport> {
  const cenarios: ScenarioScore[] = [];
  let firstTries = 0;
  for (const scenario of input.scenarios) {
    const score: ScenarioScore = { id: scenario.id, titulo: scenario.titulo, tentativas: input.k, acertos: 0, passouTodas: false, falhas: [] };
    for (let attempt = 1; attempt <= input.k; attempt += 1) {
      const run = await runScenario({ agent: input.agent, deps: input.deps(), scenario, fornecedorModel: input.fornecedorModel });
      const checks = run.erro ? [{ nome: "rodou_sem_erro", ok: false, detalhe: run.erro }] : scenario.verificar(run);
      const ok = checks.every((check) => check.ok);
      if (ok) score.acertos += 1;
      else score.falhas.push({ tentativa: attempt, checks, transcript: renderRun(run), erro: run.erro });
      if (attempt === 1 && ok) firstTries += 1;
      input.onProgress?.(`${scenario.id} #${attempt}: ${ok ? "ok" : `falhou (${checks.filter((check) => !check.ok).map((check) => check.nome).join(", ")})`}`);
    }
    score.passouTodas = score.acertos === input.k;
    cenarios.push(score);
  }
  const total = cenarios.length || 1;
  return {
    agente: input.agent.id,
    modelo: input.deps().model.id,
    k: input.k,
    cenarios,
    passK: cenarios.filter((scenario) => scenario.passouTodas).length / total,
    passAt1: firstTries / total
  };
}

export function renderRun(run: ScenarioRun<unknown, unknown>) {
  const lines: string[] = [];
  for (const turno of run.turnos) {
    const jogada = turno.resultado.jogada?.tipo ?? "—";
    const revisoes = turno.resultado.trace.filter((step) => step.fase === "revisao").map((step) => JSON.stringify(step.detalhe));
    lines.push(`▸ ${turno.evento}`);
    lines.push(`   jogada: ${jogada}${revisoes.length ? ` · revisão: ${revisoes.join(" → ")}` : ""}`);
    if (turno.resultado.enviar) lines.push(`   agente: ${turno.resultado.enviar}`);
    if (turno.resultado.humano) lines.push(`   → HUMANO: ${turno.resultado.humano.motivo}`);
  }
  if (run.erro) lines.push(`ERRO: ${run.erro}`);
  return lines.join("\n");
}

export function renderReport(report: SuiteReport) {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const lines = [
    `# Simulador: agente ${report.agente}`,
    "",
    `Modelo: ${report.modelo} · ${report.k} tentativas por cenário`,
    "",
    `**Passou todas as ${report.k} vezes: ${pct(report.passK)}** dos cenários · acertou na primeira: ${pct(report.passAt1)}`,
    "",
    "| Cenário | Acertos | Resultado |",
    "|---|---|---|",
    ...report.cenarios.map((scenario) => `| ${scenario.titulo} | ${scenario.acertos}/${scenario.tentativas} | ${scenario.passouTodas ? "✅" : "❌"} |`)
  ];
  for (const scenario of report.cenarios.filter((item) => item.falhas.length)) {
    lines.push("", `## ${scenario.titulo}`);
    for (const falha of scenario.falhas) {
      lines.push("", `Tentativa ${falha.tentativa}: ${falha.checks.filter((check) => !check.ok).map((check) => `${check.nome}${check.detalhe ? ` (${check.detalhe})` : ""}`).join("; ")}`, "", "```", falha.transcript, "```");
    }
  }
  return lines.join("\n");
}
