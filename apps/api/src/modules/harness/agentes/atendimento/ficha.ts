import type { ContextoDoAtendimento, FichaDoAtendimento, Prova } from "./tipos.js";

export function fichaInicial(): FichaDoAtendimento {
  return { contato: { tipo: "indefinido", prova: null }, pendencias: [], encerrada: null, emAndamento: null, indicado: null, followups: [] };
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
  if (ficha.followups.length) lines.push(`Follow-ups já enviados: ${ficha.followups.map((item) => `"${item.texto}" (${item.pendenciaId})`).join(" | ")}`);
  return lines.join("\n");
}

export function renderContexto(contexto: ContextoDoAtendimento): string {
  return [
    `Empresa: ${contexto.empresa.nome}. ${contexto.empresa.oQueVende}`,
    ...(contexto.regrasDaEmpresa ? [`Regras da empresa: ${contexto.regrasDaEmpresa}`] : [])
  ].join("\n");
}
