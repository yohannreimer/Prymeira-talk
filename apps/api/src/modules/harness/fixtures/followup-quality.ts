import type { FollowupDoHarness, MensagemDaConversa } from "../agentes/atendimento/producao.js";
import { fichaInicial } from "../agentes/atendimento/ficha.js";

type Row = ["contato" | "humano", string, "audio"?];
export type FollowupQualityCase = {
  id: string; group: "error" | "control"; goal: string;
  expected: FollowupDoHarness["tipo"][]; rows: Row[]; require?: string[]; forbid?: string[];
};

/** Synthetic, anonymized reproductions: no customer identities, transcripts or production IDs. */
export const followupQualityCases: FollowupQualityCase[] = [
  { id: "separate-old-and-new-angle", group: "error", goal: "Não misturar espessura/quantidade do pedido antigo com o novo galvanizado indisponível.", expected: ["nada"], rows: [
    ["contato", "Quero cotar 2 cantoneiras de 6m e 5mm."], ["humano", "Qual a largura?"],
    ["contato", 'Agora preciso de cantoneira 20x20mm 1/8 galvanizada, barra de 6m.'],
    ["humano", "Galvanizada não trabalho, só preta aço carbono natural."], ["contato", "Preciso que seja galvanizada."], ["humano", "Infelizmente essa não consigo fornecer."] ] },
  { id: "exclude-refused-tubes-from-mixed-order", group: "error", goal: "Continuar apenas com cantoneiras e barras chatas, sem pedir dados dos tubos recusados em áudio.", expected: ["mensagem"], require: ["cantoneir|chata"], forbid: ["tub"], rows: [
    ["contato", "Qual valor de cantoneira 5cm largura, barra chata 5cm e tubo quadrado 5x5cm? Barras de 6m."],
    ["humano", "Cantoneira e barra chata trabalho, mas falta a espessura e quantidade. Tubos eu não trabalho.", "audio"] ] },
  { id: "unavailable-sheet-format", group: "error", goal: "Não lembrar cotação de1500x3000 recusada; confirmar se a alternativa1200x3000 serve.", expected: ["mensagem"], require: ["1200|1[,.]2(?:0)?(?:\\s|m|x|×)"], forbid: ["enviar cotação|mandar orçamento"], rows: [
    ["contato", "Consegue cotar uma chapa aço carbono0,90mm1500x3000?"],
    ["humano", "0,90 só em1,20por3m. Em1,50por3 não trabalho, nunca tive esse formato.", "audio"] ] },
  { id: "supplier-search-already-answered", group: "error", goal: "Busca já concluída sem fornecedor viável não pode reaparecer como cotação ainda sem resposta.", expected: ["nada"], rows: [
    ["contato", "Preciso de orçamento das vigas com a seção especial mostrada no projeto. Preciso prazo, pagamento e frete."],
    ["humano", "Procurei em cinco fornecedores e nenhum tem essas medidas. Não consegui fornecer essas vigas.", "audio"], ["contato", "Certo, obrigado pela resposta."] ] },
  { id: "cash-after-credit-refusal", group: "control", goal: "Manter a decisão de pagamento à vista em aberto, sem prometer crédito.", expected: ["mensagem"], require: ["vista"], forbid: ["crédito aprovado|boleto liberado"], rows: [
    ["contato", "Quero seguir com as vigas do orçamento. Posso faturar?"], ["humano", "Financeiro não liberou crédito na primeira compra, precisa ser à vista.", "audio"], ["contato", "Vou tentar fazer à vista."] ] },
  { id: "new-sheet-quote-after-delivered-order", group: "control", goal: "Retomar só a cotação nova de dez chapas de cada formato, sem misturar o pedido entregue.", expected: ["mensagem"], require: ["chapa"], forbid: ["5 chapas|cinco chapas|entrega pendente"], rows: [
    ["contato", "Confirmo as5chapas4,75mm."], ["humano", "Pedido pago e entregue, tudo certo."],
    ["contato", "Novo pedido:10chapas2,65mm1200x3000 e10chapas2,65mm1500x3000."], ["humano", "Segue ORÇAMENTO NOVO.pdf com dez de cada formato."], ["contato", "Vou avaliar esse orçamento novo."] ] },
  { id: "old-beam-quote-survives-tube-refusal", group: "control", goal: "Recusa só dos tubos não cancela cotação de viga ainda aberta.", expected: ["mensagem"], require: ["viga|W200|perfil"], forbid: ["tubo"], rows: [
    ["contato", "Pode cotar vigaW200x26,60,4barras6m?"], ["humano", "Segue orçamento das vigasW200x26,60."], ["contato", "Vou avaliar."],
    ["contato", "Outro assunto, tem tubos para amanhã?"], ["humano", "Só em dez dias úteis."], ["contato", "Então os tubos não vão servir, precisava amanhã."] ] },
  { id: "steel-grade-alternative-is-a-question", group: "control", goal: "Pode perguntar se1020serve no lugar de1045, sem afirmar equivalência.", expected: ["mensagem"], require: ["1020"], forbid: ["são equivalentes|mesma resistência|já substituí"], rows: [
    ["contato", "Quero cotar aço1045."], ["humano", "Só tenho1020. O1020atende ao que precisa?"] ] },
  { id: "complete-request-needs-company-quote", group: "control", goal: "Lista completa sem orçamento é tarefa da empresa, não dados do cliente.", expected: ["lembrete_vendedor"], rows: [
    ["contato", "Cote6chapasA36de3mm1200x3000, entregaJoinville, pagamentoàvista. Cadastro já enviado."], ["humano", "Recebi o pedido e vou preparar a proposta."] ] },
  { id: "seller-deadline-preserved", group: "control", goal: "Manter prazo negociado de cinco úteis, sem prometer pronta entrega.", expected: ["mensagem"], require: ["5|cinco|prazo"], forbid: ["pronta entrega|em estoque"], rows: [
    ["contato", "PrecisoW360x64eW360x57,8. Tem pronta entrega?"], ["humano", "Para essas vigas consigo em cinco dias úteis. Esse prazo serve?"] ] },
  { id: "corrected-quote-awaits-decision", group: "control", goal: "Retomar orçamento corrigido sem recuperar o preço inválido.", expected: ["mensagem"], require: ["orçamento|cotaç|chapa"], forbid: ["R\\$"], rows: [
    ["contato", "Cote chapa19,05mm1500x3000."], ["humano", "O valor que mandei estava errado. Segue o orçamento corrigido.pdf, desconsidere o anterior."] ] },
  { id: "accepted-alternative-still-needs-quote", group: "control", goal: "Cliente pediu orçamento da alternativa; cobrar vendedor, sem voltar a pedir aceite.", expected: ["lembrete_vendedor"], rows: [
    ["contato", "Preciso chapa piso1,25em tamanho especial."], ["humano", "Só tenho2,65mm1200x3000. Atende?"], ["contato", "Pode mandar o orçamento dessa alternativa para eu validar com a manutenção."] ] },
  { id: "promised-tube-quote-still-open", group: "control", goal: "Prazo aceito e cotação prometida mantêm tarefa do vendedor aberta.", expected: ["lembrete_vendedor"], rows: [
    ["contato", "Preciso95tubos120x100x4,25com6m."], ["humano", "Prazo7a10diasúteis. Serve?"], ["contato", "Serve. Preciso do orçamento formal."], ["humano", "Vou enviar amanhã."] ] },
  { id: "thanks-is-not-purchase-closure", group: "control", goal: "Agradecimento por orçamento não encerra a compra.", expected: ["mensagem"], rows: [
    ["contato", "Preciso cotar tubos40x40x1,5e chapa piso3mm, já mandei quantidades e comprimentos."], ["humano", "Segue orçamento solicitado.pdf."], ["contato", "Obrigado!"] ] },
  { id: "beam-alternative-without-equivalence", group: "control", goal: "Perguntar se W150x13 atende é permitido; garantir equivalência com I10 não é.", expected: ["mensagem"], require: ["W\\s?150|alternativa"], forbid: ["equivalente|mesma resistência|pode substituir sem"], rows: [
    ["contato", "Quero2vigasI10polegadasde6m."], ["humano", "Essa não tenho. Posso oferecerW150x13. Serve para o seu projeto?"] ] },
  { id: "missing-length-really-needs-customer", group: "control", goal: "Pedir comprimento ainda ausente, preservando diâmetro e parede.", expected: ["mensagem"], require: ["comprimento|metros"], forbid: ["qual diâmetro|qual espessura"], rows: [
    ["contato", "Cote5tubos8polegadasparede3,75e5tubos6polegadasparede3. Ainda não informei comprimento."], ["humano", "Qual o comprimento de cada tubo?"] ] }
  ,{ id: "explicit-parallel-orders-of-same-product", group: "control", goal: "Pedidos explicitamente separados do mesmo produto não se cancelam: preservar a cantoneira5mm ainda válida.", expected: ["mensagem"], require: ["largura|5\\s?mm"], forbid: ["galvanizada"], rows: [
    ["contato", "Quero 2 cantoneiras de 6m e 5mm para a obra A."], ["humano", "Qual a largura para a obra A?"],
    ["contato", "Outro pedido separado, para a obra B: cantoneira20x20mm1/8galvanizada6m. O pedido de5mm da obra A continua valendo."],
    ["humano", "A galvanizada para a obra B não forneço. As cantoneiras da obra A consigo, só falta a largura."], ["contato", "Certo, vou verificar a largura para a obra A."] ] }
];

export function qualityMessages(item: FollowupQualityCase): MensagemDaConversa[] {
  return item.rows.map(([autor, texto, tipo], i) => ({ id: `${item.id}-${i}`, autor, texto, tipo: tipo ?? "text",
    em: new Date(Date.UTC(2026, 10, 10, 12, i)).toISOString() }));
}

/** The production regression must also repair an already-saved obsolete pending item. */
export function qualitySession(item: FollowupQualityCase) {
  if (item.id !== "separate-old-and-new-angle") return {};
  return { harness: { ficha: { ...fichaInicial(), contato: { tipo: "cliente", prova: null }, pendencias: [
    { id: "p1", dono: "cliente", descricao: "Informar largura das2cantoneiras6m5mm do pedido antigo.",
      prova: { mensagem: 1, trecho: "Qual a largura?" }, doContato: { mensagem: 0, trecho: item.rows[0][1] },
      status: "aberta", resolvidaPor: null }
  ] } } };
}

export function assessQualityResult(item: FollowupQualityCase, result: FollowupDoHarness) {
  const text = result.tipo === "mensagem" ? result.texto : result.tipo === "lembrete_vendedor" ? `${result.motivo}\n${result.resumo}` : "";
  const failures = [
    ...(!item.expected.includes(result.tipo) ? [`action:${result.tipo}`] : []),
    ...(item.require ?? []).filter(pattern => !new RegExp(pattern, "iu").test(text)).map(pattern => `missing:${pattern}`),
    ...(item.forbid ?? []).filter(pattern => new RegExp(pattern, "iu").test(text)).map(pattern => `forbidden:${pattern}`)
  ];
  return { passed: failures.length === 0, failures, text };
}
