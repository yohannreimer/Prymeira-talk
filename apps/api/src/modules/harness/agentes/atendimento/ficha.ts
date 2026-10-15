import type { BaseDeConhecimento, ContextoDoAtendimento, FichaDoAtendimento, Prova, TrechoDaBase } from "./tipos.js";

export function fichaInicial(): FichaDoAtendimento {
  return {
    contato: { tipo: "indefinido", prova: null },
    pendencias: [],
    encerrada: null,
    emAndamento: null,
    indicado: null,
    followups: [],
    perguntas: [],
    trechosVistos: {},
    pediuPessoa: false
  };
}

export const pendenciasAbertas = (ficha: FichaDoAtendimento) => ficha.pendencias.filter((item) => item.status === "aberta");

const prova = (value: Prova | null) => value ? ` (msg [${value.mensagem}]: "${value.trecho}")` : "";

export function renderFicha(ficha: FichaDoAtendimento): string {
  const lines = [`Contato: ${ficha.contato.tipo}${prova(ficha.contato.prova)}`];
  if (ficha.pendencias.length === 0) lines.push("Pendências: nenhuma registrada");
  for (const item of ficha.pendencias) {
    lines.push(`- ${item.id} [${item.status}] vez do ${item.dono}: ${item.descricao}${prova(item.prova)}${item.resolvidaPor ? ` · resolvida${prova(item.resolvidaPor)}` : ""}`);
  }
  if (ficha.encerrada) lines.push(`Encerrada: ${ficha.encerrada.motivo}${prova(ficha.encerrada.prova)}`);
  if (ficha.emAndamento) lines.push(`Em andamento: ${ficha.emAndamento.motivo}${prova(ficha.emAndamento.prova)}`);
  if (ficha.indicado) lines.push(`Contato indicado: ${ficha.indicado.nome}${ficha.indicado.telefone ? ` ${ficha.indicado.telefone}` : ""}${prova(ficha.indicado.prova)}`);
  for (const pergunta of ficha.perguntas.filter((item) => item.status !== "tratada")) {
    const resposta = pergunta.resposta ? ` · base ${pergunta.resposta.trechoId}: "${pergunta.resposta.citacao}"` : "";
    lines.push(`Pergunta ${pergunta.id} [${pergunta.status}]: ${pergunta.texto}${resposta}`);
  }
  if (ficha.pediuPessoa) lines.push("O contato pediu para falar com uma pessoa.");
  if (ficha.followups.length) lines.push(`Follow-ups já enviados: ${ficha.followups.map((item) => `"${item.texto}" (${item.pendenciaId})`).join(" | ")}`);
  return lines.join("\n");
}

export function renderContexto(contexto: ContextoDoAtendimento): string {
  return [
    `Empresa: ${contexto.empresa.nome}. ${contexto.empresa.oQueVende}`,
    ...(contexto.regrasDaEmpresa ? [`Regras da empresa: ${contexto.regrasDaEmpresa}`] : [])
  ].join("\n");
}

const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** A small in-memory base for the simulator and tests: passages ranked by shared words with the query. */
export function baseEmMemoria(trechos: TrechoDaBase[], limite = 3): BaseDeConhecimento {
  const words = (text: string) => new Set(normalize(text).match(/[a-z0-9]{3,}/g) ?? []);
  return {
    buscar(consulta) {
      const query = words(consulta);
      return trechos
        .map((trecho) => ({ trecho, score: [...words(`${trecho.titulo} ${trecho.texto}`)].filter((word) => query.has(word)).length }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limite)
        .map((item) => item.trecho);
    }
  };
}
