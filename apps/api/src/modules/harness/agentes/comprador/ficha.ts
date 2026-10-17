import { formatBRL } from "../../core/dinheiro.js";
import type { FichaDoFornecedor, PedidoDeCompra, VersaoDaProposta } from "./tipos.js";

export function fichaInicial(): FichaDoFornecedor {
  return {
    contato: { nome: null, ehRobo: false, humanoConfirmado: false },
    etapa: "nao_iniciado",
    propostas: [],
    choradinhas: { usadas: 0, totalAntes: null },
    cobrancas: 0,
    perguntouValorConcorrente: false,
    perguntouNomeConcorrente: false,
    perguntasPendentes: [],
    fornecedorVaiVerificar: false,
    semDesconto: false,
    valorConcorrenteRevelado: false,
    observacoes: [],
    motivoRecusa: null,
    versoesNaTriagem: 0
  };
}

export function propostaAtual(ficha: FichaDoFornecedor): VersaoDaProposta | null {
  return ficha.propostas.at(-1) ?? null;
}

/** Total of a version (items × quantity + freight), or null while any item has no price. */
export function totalDaProposta(versao: VersaoDaProposta | null, pedido: PedidoDeCompra): number | null {
  if (!versao) return null;
  let total = 0;
  for (const item of pedido.itens) {
    const preco = versao.itens.find((line) => line.itemId === item.id)?.precoUnitario;
    if (preco === undefined) return null;
    total += preco * item.quantidade;
  }
  return round2(total + (versao.frete ?? 0));
}

/** What is still missing for a quote we can compare. Validity is asked but does not block. */
export function faltantes(ficha: FichaDoFornecedor, pedido: PedidoDeCompra): string[] {
  const versao = propostaAtual(ficha);
  const missing: string[] = [];
  for (const item of pedido.itens) {
    if (!versao?.itens.some((line) => line.itemId === item.id)) missing.push(`preço unitário de ${item.descricao}`);
  }
  if (versao?.frete === null || versao?.frete === undefined) missing.push("valor do frete até o CEP");
  if (!versao?.prazoEntrega) missing.push("prazo de entrega");
  if (!versao?.pagamento) missing.push("condição de pagamento");
  return missing;
}

export function propostaCompleta(ficha: FichaDoFornecedor, pedido: PedidoDeCompra) {
  return faltantes(ficha, pedido).length === 0;
}

/** Every money amount the agent may write in this conversation: the supplier's own numbers. */
export function valoresPermitidos(ficha: FichaDoFornecedor, pedido: PedidoDeCompra): number[] {
  const values: number[] = [];
  for (const versao of ficha.propostas) {
    for (const line of versao.itens) {
      values.push(line.precoUnitario);
      const item = pedido.itens.find((candidate) => candidate.id === line.itemId);
      if (item) values.push(round2(line.precoUnitario * item.quantidade));
    }
    if (versao.frete !== null) values.push(versao.frete);
    const total = totalDaProposta(versao, pedido);
    if (total !== null) values.push(total, round2(total - (versao.frete ?? 0)));
  }
  if (ficha.choradinhas.totalAntes !== null) values.push(ficha.choradinhas.totalAntes);
  const reducao = reducaoDaChoradinha(ficha, pedido);
  if (reducao) values.push(reducao.valor);
  return values;
}

/** How much the price-improvement ask got, comparing the total before it with the current one. */
export function reducaoDaChoradinha(ficha: FichaDoFornecedor, pedido: PedidoDeCompra): { valor: number; percentual: number } | null {
  const antes = ficha.choradinhas.totalAntes;
  const agora = totalDaProposta(propostaAtual(ficha), pedido);
  if (antes === null || agora === null || agora >= antes) return null;
  return { valor: round2(antes - agora), percentual: Math.round(((antes - agora) / antes) * 1000) / 10 };
}

export function renderFicha(ficha: FichaDoFornecedor, pedido: PedidoDeCompra): string {
  const versao = propostaAtual(ficha);
  const total = totalDaProposta(versao, pedido);
  const lines = [
    `Contato: ${ficha.contato.nome ?? "nome não informado"}${ficha.contato.ehRobo && !ficha.contato.humanoConfirmado ? " (até agora só respondeu um robô)" : ""}`,
    `Etapa: ${ficha.etapa}`,
    versao
      ? [
          `Proposta atual (versão ${ficha.propostas.length}):`,
          ...pedido.itens.map((item) => {
            const preco = versao.itens.find((line) => line.itemId === item.id)?.precoUnitario;
            return `  - ${item.descricao}: ${preco === undefined ? "sem preço ainda" : `${formatBRL(preco)} por ${item.unidade} (${formatBRL(round2(preco * item.quantidade))} por ${item.quantidade})`}`;
          }),
          `  - Frete: ${versao.frete === null ? "não informado" : versao.frete === 0 ? "grátis" : formatBRL(versao.frete)}`,
          `  - Prazo de entrega: ${versao.prazoEntrega ?? "não informado"}`,
          `  - Pagamento: ${versao.pagamento ?? "não informado"}`,
          `  - Validade: ${versao.validade ?? "não informada"}`,
          ...(versao.observacao ? [`  - Observação do fornecedor: ${versao.observacao}`] : []),
          `  - Total com frete: ${total === null ? "incompleto" : formatBRL(total)}`
        ].join("\n")
      : "Proposta: nenhuma ainda",
    `Faltando: ${faltantes(ficha, pedido).join(", ") || "nada"}`,
    `Choradinhas feitas: ${ficha.choradinhas.usadas} de ${pedido.privado.maxChoradinhas}${ficha.choradinhas.totalAntes !== null ? ` (total antes: ${formatBRL(ficha.choradinhas.totalAntes)})` : ""}`,
    ...(reducaoDaChoradinha(ficha, pedido) ? [`Resultado da choradinha: ${formatBRL(reducaoDaChoradinha(ficha, pedido)!.valor)} a menos`] : []),
    ...(ficha.semDesconto ? ["O fornecedor disse que não consegue melhorar o preço."] : []),
    ...(ficha.fornecedorVaiVerificar ? ["O fornecedor disse que vai verificar e retornar."] : []),
    ...(ficha.perguntasPendentes.length ? [`Perguntas do fornecedor ainda sem resposta: ${ficha.perguntasPendentes.join(" | ")}`] : []),
    ...(ficha.observacoes.length ? [`Observações: ${ficha.observacoes.join(" | ")}`] : []),
    `Cobranças enviadas: ${ficha.cobrancas}`
  ];
  return lines.join("\n");
}

export function renderPedidoPublico(pedido: PedidoDeCompra): string {
  return [
    `Empresa compradora: ${pedido.empresa.nome}${pedido.empresa.descricao ? ` (${pedido.empresa.descricao})` : ""}`,
    "Itens:",
    ...pedido.itens.map((item) => `  - [id ${item.id}] ${item.quantidade} ${item.unidade} de ${item.descricao}${item.especificacao ? ` (${item.especificacao})` : ""}`),
    `Entrega até: ${formatDate(pedido.dataEntrega)}, no CEP ${pedido.cep}${pedido.cidade ? ` (${pedido.cidade})` : ""}`,
    `Precisa de nota fiscal: ${pedido.exigeNotaFiscal ? "sim" : "não"}`,
    ...(pedido.pagamentoPreferido ? [`Pagamento preferido: ${pedido.pagamentoPreferido}`] : []),
    `Recebemos orçamentos até: ${formatDate(pedido.prazoResposta)}`,
    ...(pedido.observacoes ? [`Observações: ${pedido.observacoes}`] : [])
  ].join("\n");
}

export function formatDate(iso: string) {
  const [year, month, day] = iso.slice(0, 10).split("-");
  return day && month && year ? `${day}/${month}/${year}` : iso;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}
