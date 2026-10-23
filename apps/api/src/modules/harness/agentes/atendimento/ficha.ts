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
    lines.push(`- ${item.id} [${item.status}] vez do ${item.dono}: ${item.descricao}${prova(item.prova)}${item.doContato && item.doContato.mensagem !== item.prova.mensagem ? ` · contato${prova(item.doContato)}` : ""}${item.resolvidaPor ? ` · resolvida${prova(item.resolvidaPor)}` : ""}`);
  }
  if (ficha.encerrada) lines.push(`Encerrada: ${ficha.encerrada.motivo}${prova(ficha.encerrada.prova)}`);
  if (ficha.emAndamento) lines.push(`Em andamento: ${ficha.emAndamento.motivo}${prova(ficha.emAndamento.prova)}`);
  if (ficha.indicado) lines.push(`Contato indicado: ${ficha.indicado.nome}${ficha.indicado.telefone ? ` ${ficha.indicado.telefone}` : ""}${prova(ficha.indicado.prova)}`);
  for (const pergunta of ficha.perguntas.filter((item) => item.status !== "tratada")) {
    const resposta = [pergunta.resposta, ...(pergunta.maisRespostas ?? [])].filter((item) => item !== null).map((item) => ` · base ${item.trechoId}: "${item.citacao}"`).join("");
    lines.push(`${pergunta.natureza === "solicitacao" ? "Solicitação" : "Pergunta"} ${pergunta.id} [${pergunta.status}]: ${pergunta.texto}${resposta}`);
  }
  if (ficha.prequalificacao) {
    lines.push(`Pré-qualificação interna: ${ficha.prequalificacao.situacao}. ${ficha.prequalificacao.resumo}`);
    lines.push(`Faltantes: ${ficha.prequalificacao.faltantes.join("; ") || "nenhum"}`);
    lines.push(`Divergências para o orçamento (não recitar ao cliente): ${ficha.prequalificacao.divergencias.join("; ") || "nenhuma"}`);
  }
  if (ficha.pediuPessoa) lines.push("O contato pediu para falar com uma pessoa.");
  if (ficha.anexosDaVez?.length) lines.push(`Vai anexado nesta resposta: ${ficha.anexosDaVez.join(", ")}`);
  if (ficha.anexosEnviados?.length) lines.push(`Já enviado antes: ${ficha.anexosEnviados.join(", ")}`);
  if (ficha.followups.length) lines.push(`Follow-ups já enviados: ${ficha.followups.map((item) => `"${item.texto}" (${item.pendenciaId})`).join(" | ")}`);
  return lines.join("\n");
}

export function renderContexto(contexto: ContextoDoAtendimento): string {
  return [
    `Empresa: ${contexto.empresa.nome}. ${contexto.empresa.oQueVende}`,
    ...(contexto.regrasDaEmpresa ? [`Regras da empresa:\n${contexto.regrasDaEmpresa}`] : []),
    ...(contexto.anexos?.length ? [`Arquivos aprovados para envio (só com enviar_anexo): ${contexto.anexos.map((anexo) => `${anexo.id} (${anexo.titulo})`).join(", ")}`] : [])
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

/**
 * The company's knowledge sources (long texts as they wrote them) cut into small titled passages, so a
 * search returns the paragraph or catalogue line that answers, not a 5,000-character document.
 * Bullet lines keep the section heading above them ("LINHA DE ESTOQUE…") in their title.
 */
export function trechosDeFontes(fontes: Array<{ title: string; content: string | null }>, tamanho = 600): TrechoDaBase[] {
  const vistos = new Set<string>();
  const trechos: TrechoDaBase[] = [];
  for (const fonte of fontes) {
    const conteudo = (fonte.content ?? "").trim();
    if (!conteudo || vistos.has(`${fonte.title}\n${conteudo}`)) continue;
    vistos.add(`${fonte.title}\n${conteudo}`);
    let secao = "";
    const partes: Array<{ titulo: string; texto: string }> = [];
    for (const paragrafo of conteudo.split(/\n\s*\n/)) {
      for (const linha of paragrafo.split(/\n(?=- )/)) {
        const texto = linha.trim();
        if (!texto) continue;
        // A short all-caps line is a heading for what follows.
        if (texto.length < 80 && texto === texto.toUpperCase() && /[A-ZÀ-Ú]{4}/.test(texto) && !texto.includes(":")) {
          secao = texto.replace(/[.:]+$/, "");
          continue;
        }
        partes.push({ titulo: secao ? `${fonte.title} · ${secao}` : fonte.title, texto: texto.replace(/^- /, "") });
      }
    }
    for (const parte of partes) {
      for (const pedaco of cortar(parte.texto, tamanho)) trechos.push({ id: `t${trechos.length + 1}`, titulo: parte.titulo, texto: pedaco });
    }
  }
  return trechos;
}

/** Sentences, ending at punctuation followed by a space: "6.000 mm" and "1,5" stay whole. Nothing is dropped. */
export const frasesDe = (texto: string) => (texto.match(/[\s\S]+?(?:[.!?]+(?=\s|$)\s*|$)/g) ?? [texto]).filter((frase) => frase.length > 0);

/** Long text into pieces of whole sentences. */
function cortar(texto: string, tamanho: number): string[] {
  if (texto.length <= tamanho) return [texto];
  const frases = frasesDe(texto);
  const pedacos: string[] = [];
  let atual = "";
  for (const frase of frases) {
    if (atual && (atual + frase).length > tamanho) {
      pedacos.push(atual.trim());
      atual = "";
    }
    atual += frase;
  }
  if (atual.trim()) pedacos.push(atual.trim());
  return pedacos;
}

/**
 * A small base is read whole instead of searched: with a few dozen passages, keyword search loses more
 * (synonyms, plurals, a title that matches everything) than reading costs. Above the limit, it searches.
 */
export function baseCompleta(trechos: TrechoDaBase[], limiteDeCaracteres = 24_000): BaseDeConhecimento {
  const busca = baseEmMemoria(trechos, 4);
  const total = trechos.reduce((soma, trecho) => soma + trecho.titulo.length + trecho.texto.length, 0);
  return total <= limiteDeCaracteres ? { buscar: busca.buscar, todos: () => trechos } : busca;
}
