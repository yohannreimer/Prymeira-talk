import type { HarnessMessage } from "../../core/types.js";
import type { Check, Scenario, ScenarioRun } from "../../simulador/simulador.js";
import { semelhanca } from "./regras.js";
import { baseEmMemoria } from "./ficha.js";
import type { Catalogo } from "./catalogo.js";
import type { BaseDeConhecimento, ContextoDoAtendimento, FichaDoAtendimento, TrechoDaBase } from "./tipos.js";

type Cenario = Scenario<FichaDoAtendimento, ContextoDoAtendimento>;
type Run = ScenarioRun<FichaDoAtendimento, ContextoDoAtendimento>;

/** A made-up but realistic slice of a steel distributor's approved knowledge, for the live-reply scenarios. */
export const BASE_VILLEFER: TrechoDaBase[] = [
  { id: "entrega", titulo: "Entrega e frete", texto: "Entrega própria em Joinville, Jaraguá do Sul e Blumenau em até 48 horas úteis após o faturamento. Frete grátis em Joinville para pedidos acima de R$ 3.000. Outras cidades: frete por transportadora, cotado pelo vendedor." },
  { id: "pagamento", titulo: "Formas de pagamento", texto: "Aceitamos PIX, cartão em até 3x e boleto 28 dias para empresas com cadastro aprovado. Cadastro: enviar CNPJ e contrato social." },
  { id: "chapas", titulo: "Chapas", texto: "Chapas de aço carbono laminadas a frio e a quente, de 0,90 mm a 25,4 mm, nos formatos 1000x2000, 1200x3000 e 1500x3000, em estoque permanente. Chapa xadrez de 1/8 a 1/4." },
  { id: "corte", titulo: "Corte sob medida", texto: "Fazemos corte a laser e guilhotina em chapas até 12,7 mm. Para orçamento, enviar desenho em DXF ou PDF e a quantidade." },
  { id: "tubos", titulo: "Tubos e metalon", texto: "Tubos industriais redondos, quadrados e retangulares (metalon) de 20x20 a 100x100, paredes #18 a #11, barras de 6 metros." },
  { id: "linha", titulo: "O que não trabalhamos", texto: "Não trabalhamos com aço inox nem com alumínio." }
];

export const contextoVillefer = (overrides: Partial<ContextoDoAtendimento> = {}): ContextoDoAtendimento => ({
  empresa: { nome: "Villefer", oQueVende: "Distribuidora de aço: chapas, perfis, tubos, barras e telhas, com corte sob medida." },
  maxFollowups: 3,
  base: baseEmMemoria(BASE_VILLEFER),
  ...overrides
});

/**
 * A past conversation from short lines: "C:" contact, "E:" the AI agent, "V:" a seller from the company.
 * Messages are 3 minutes apart, ending the day before the simulator clock starts.
 */
export function conversa(...linhas: string[]): HarnessMessage[] {
  const start = Date.parse("2026-10-14T12:00:00.000Z") - linhas.length * 3 * 60_000;
  return linhas.map((linha, index) => {
    const autor = linha.startsWith("C:") ? "contato" : linha.startsWith("V:") ? "humano" : "agente";
    return { autor, texto: linha.slice(2).trim(), em: new Date(start + index * 3 * 60_000).toISOString() };
  });
}

/** Moves the agent made on silences, in order. */
export const jogadasNoSilencio = (run: Run) => run.turnos.filter((turno) => turno.evento === "silencio").map((turno) => turno.resultado.jogada?.tipo ?? "—");
export const followupsEnviados = (run: Run) => run.turnos.filter((turno) => turno.evento === "silencio" && turno.resultado.enviar).map((turno) => turno.resultado.enviar!);

/** Checks every follow-up scenario gets: never repeats itself, never exceeds the attempts. */
export function checksComuns(run: Run): Check[] {
  const enviados = followupsEnviados(run);
  const repetidos = enviados.flatMap((texto, index) => enviados.slice(index + 1).filter((outro) => semelhanca(texto, outro) >= 0.6).map(() => texto));
  return [
    { nome: "nao_repetiu_followup", ok: repetidos.length === 0, detalhe: repetidos[0] },
    { nome: "respeitou_limite", ok: enviados.length <= run.pedido.maxFollowups, detalhe: `${enviados.length} enviados` }
  ];
}

const silencioso = { tipo: "roteiro" as const, responder: () => null };

/** Expects the first silence to end in one of these moves. For cobrar_pendencia, the text must talk about the open item. */
function espera(input: { jogadas: string[]; fala?: RegExp; naoFala?: RegExp; lembrete?: RegExp }) {
  return (run: Run): Check[] => {
    const primeira = jogadasNoSilencio(run)[0] ?? "nenhuma";
    const texto = followupsEnviados(run)[0] ?? "";
    const checks: Check[] = [...checksComuns(run), { nome: "jogada_certa", ok: input.jogadas.includes(primeira), detalhe: `esperado ${input.jogadas.join(" ou ")}, veio ${primeira}` }];
    if (input.fala) checks.push({ nome: "fala_da_pendencia", ok: input.fala.test(texto), detalhe: texto || "(nada enviado)" });
    if (input.naoFala) checks.push({ nome: "nao_fala_de_assunto_velho", ok: !input.naoFala.test(texto), detalhe: texto });
    if (input.lembrete) checks.push({ nome: "lembrete_certo", ok: input.lembrete.test(run.humano?.motivo ?? ""), detalhe: run.humano?.motivo ?? "(sem lembrete)" });
    return checks;
  };
}

const QUIETO = ["contato_nao_cliente", "encerrada", "em_andamento", "nada_aberto"];

/**
 * Reconstructed from the 15 real conversations of the follow-up test of 10/10 (resultado-teste-1.md),
 * plus the classic cases. The texts are rewritten from the summaries, not copied from the database:
 * real exported conversations go in through `cenariosDeCasos`.
 */
export const cenarios: Cenario[] = [
  {
    id: "lead_falta_medida",
    titulo: "Lead pediu perfil e não mandou tipo e medida (Anderson)",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "C: Boa tarde, vocês têm perfil pra estrutura de mezanino?",
      "E: Boa tarde! Temos sim. Qual o tipo de perfil (U, I, W) e a medida que você precisa?",
      "C: deixa eu ver com o engenheiro aqui"
    ),
    exigeModelo: true,
    verificar: espera({ jogadas: ["cobrar_pendencia"], fala: /perfil|medida|engenheiro/i })
  },
  {
    id: "retirada_em_andamento",
    titulo: "Cliente a caminho da retirada (Lindomar)",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "C: as barras chatas já tão separadas?",
      "V: Tudo separado, pode vir buscar até as 17h",
      "C: blz to saindo daqui agora",
      "C: [localização enviada]"
    ),
    exigeModelo: true,
    verificar: espera({ jogadas: ["em_andamento", "nada_aberto", "encerrada"] })
  },
  {
    id: "indicou_comprador",
    titulo: "Prospecção devolveu o contato do comprador (Epex)",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "E: Olá! Aqui é da Villefer, distribuidora de aço. Vocês compram chapas e perfis com frequência?",
      "C: oi, quem cuida disso é o Wellington do compras",
      "C: 47 99812-3344"
    ),
    exigeModelo: true,
    verificar: espera({ jogadas: ["lembrete_vendedor"], lembrete: /wellington/i })
  },
  {
    id: "empresa_prometeu_nf",
    titulo: "Empresa prometeu mandar a NF na terça (Ituterra)",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "C: material chegou certinho, só falta a nota",
      "V: Que bom! A NF eu te mando na terça, o financeiro tá fechando",
      "C: ok obrigado"
    ),
    exigeModelo: true,
    verificar: espera({ jogadas: ["lembrete_vendedor"], lembrete: /\bNF\b|nota/i })
  },
  {
    id: "empresa_comprando_de_fornecedor",
    titulo: "A empresa é que está comprando do contato (Sidnei)",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "V: Sidnei, tem chapa 3mm 1200x3000 aí? Preciso de 40 pra semana que vem",
      "C: tenho 25 em estoque, o resto chega dia 20",
      "V: qual o preço das 25?",
      "C: vou ver com o comercial e te passo"
    ),
    exigeModelo: true,
    verificar: espera({ jogadas: ["contato_nao_cliente"] })
  },
  {
    id: "conversa_entre_colegas",
    titulo: "Conversa entre colegas da empresa (Paulo e Henri)",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "C: Henri, me manda o e-mail da Salvar que eu preciso mandar a proposta pra eles",
      "V: vou procurar aqui",
      "C: valeu, o cliente tá esperando desde ontem"
    ),
    exigeModelo: true,
    verificar: espera({ jogadas: ["contato_nao_cliente"] })
  },
  {
    id: "conversa_pessoal",
    titulo: "Conversa pessoal (futebol)",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "C: viu o jogo ontem??",
      "V: vi kkk que vergonha",
      "C: domingo tem de novo, vai?",
      "V: acho que vou"
    ),
    exigeModelo: true,
    verificar: espera({ jogadas: ["contato_nao_cliente", "nada_aberto"] })
  },
  {
    id: "carregado_e_agradeceu",
    titulo: "Material carregado e cliente agradeceu (Fernando)",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "C: bom dia, o caminhão já tá aí pra carregar os tubos",
      "V: Bom dia! Pode encostar na doca 2",
      "C: carregado aqui, tudo certo. obrigado pela atenção",
      "V: Nós que agradecemos!"
    ),
    exigeModelo: true,
    // "o caminhão já tá aí pra carregar" also reads as a carrier; every one of these moves stays silent.
    verificar: espera({ jogadas: ["encerrada", "nada_aberto", "contato_nao_cliente"] })
  },
  {
    id: "vou_ver_com_socio",
    titulo: "Proposta enviada e 'vou ver com meu sócio'",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "C: quanto fica 30 telhas trapezoidais 0,43 de 6 metros?",
      "E: As 30 telhas TP40 0,43 de 6 m ficam R$ 8.940, pagamento em 28 dias. Retirada ou entrega?",
      "C: vou ver com meu sócio e te falo"
    ),
    exigeModelo: true,
    verificar: espera({ jogadas: ["cobrar_pendencia"], fala: /telha|s[oó]cio|proposta|or[cç]amento/i })
  },
  {
    id: "ok_depois_da_proposta",
    titulo: "'Ok' logo depois da proposta não encerra",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "C: me passa o valor de 12 barras de tubo 50x50 chapa 14",
      "E: As 12 barras de tubo 50x50 #14 ficam R$ 2.316 à vista. Posso separar?",
      "C: ok"
    ),
    exigeModelo: true,
    verificar: espera({ jogadas: ["cobrar_pendencia"], fala: /tubo|barra|separar/i })
  },
  {
    id: "assunto_velho_resolvido",
    titulo: "Assunto antigo resolvido no meio da conversa não vira pendência",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "C: preciso de orçamento de 20 barras de cantoneira 2\"",
      "E: As 20 cantoneiras 2\" x 3/16 ficam R$ 3.180. Quer que eu separe?",
      "C: vou ver",
      "C: pode separar, fechado",
      "V: Fechado! Pedido 4471 lançado, entrega quinta",
      "C: chegou certinho hoje",
      "V: Que ótimo! Qualquer coisa estamos aqui",
      "C: obrigado 👍"
    ),
    exigeModelo: true,
    verificar: espera({ jogadas: ["encerrada", "nada_aberto"] })
  },
  {
    id: "assunto_novo_depois_do_velho",
    titulo: "Pendência nova depois de um pedido já fechado: fala da nova",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "C: orçamento de 10 chapas xadrez 1/8?",
      "E: As 10 chapas xadrez 1/8 1200x3000 ficam R$ 6.210. Separo?",
      "C: fechado, pode faturar",
      "V: Faturado, pedido 4502",
      "C: agora tô precisando de metalon 30x20 também, umas 40 barras",
      "E: As 40 barras de metalon 30x20 #18 ficam R$ 2.680. Quer que eu inclua na entrega de quinta?"
    ),
    exigeModelo: true,
    verificar: espera({ jogadas: ["cobrar_pendencia"], fala: /metalon|30x20|barra|quinta/i, naoFala: /xadrez/i })
  },
  {
    id: "empresa_nunca_teve_resposta",
    titulo: "Mensagem da empresa que o contato nunca respondeu",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa("E: Olá! Aqui é da Villefer. Temos chapa e perfil com entrega em 48 h na região. Posso te mandar a tabela?"),
    exigeModelo: true,
    verificar: espera({ jogadas: ["nada_aberto", "contato_nao_cliente"] })
  },
  {
    id: "cliente_perguntou_sem_resposta",
    titulo: "Cliente perguntou e ninguém respondeu: lembrete ao vendedor",
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: conversa(
      "C: vocês fazem corte a laser?",
      "E: Fazemos sim! Me manda o desenho em DXF ou PDF e a quantidade",
      "C: [arquivo: suporte.pdf] são 200 peças, chapa 4,75. consegue pra quando?"
    ),
    exigeModelo: true,
    verificar: espera({ jogadas: ["lembrete_vendedor"], lembrete: /200|pe[cç]as|prazo|corte|desenho|quando/i })
  },
  {
    id: "duas_tentativas_sem_repetir",
    titulo: "Silêncio depois de silêncio: muda a abordagem e para no limite",
    pedido: contextoVillefer({ maxFollowups: 2 }),
    persona: silencioso,
    historicoInicial: conversa(
      "C: qual o valor do vergalhão 10mm, barra de 12m?",
      "E: O vergalhão CA-50 10 mm de 12 m sai R$ 54,90 a barra. Quantas você precisa?",
      "C: vou fazer a conta da obra e te falo"
    ),
    maxTrocas: 4,
    exigeModelo: true,
    verificar: (run) => {
      const jogadas = jogadasNoSilencio(run);
      return [
        ...checksComuns(run),
        { nome: "duas_tentativas_e_para", ok: jogadas.join(",") === "cobrar_pendencia,cobrar_pendencia,limite_de_tentativas", detalhe: jogadas.join(",") }
      ];
    }
  }
];

/** The contact sends these messages, one per turn, then stops. */
const cliente = (...mensagens: string[]) => ({ tipo: "roteiro" as const, responder: ({ vez }: { vez: number }) => mensagens[vez] ?? null });
const GENERICA = /consultar (essas |as )?informa[cç][oõ]es|j[aá] te (dou um )?retorno/i;

/** Checks for one live reply: handed over or not, what it says, and never the generic holding phrase. */
function respostaAoVivo(input: { humano?: boolean; fala?: RegExp; humanoFala?: RegExp; naoFala?: RegExp }) {
  return (run: Run): Check[] => {
    const resposta = run.turnos.find((turno) => turno.evento.startsWith("contato:"))?.resultado;
    const texto = resposta?.enviar ?? "";
    const checks: Check[] = [
      { nome: "respondeu_algo", ok: texto.length > 0, detalhe: texto || "(nada enviado)" },
      { nome: "sem_frase_generica", ok: !GENERICA.test(texto), detalhe: texto }
    ];
    if (input.humano !== undefined) checks.unshift({ nome: input.humano ? "passou_o_que_faltava" : "respondeu_sem_passar", ok: Boolean(resposta?.humano) === input.humano, detalhe: resposta?.humano?.motivo ?? "sem humano" });
    if (input.naoFala) checks.push({ nome: "nao_disse_o_que_nao_devia", ok: !input.naoFala.test(texto), detalhe: texto });
    if (input.fala) checks.push({ nome: "resposta_certa", ok: input.fala.test(texto), detalhe: texto });
    if (input.humanoFala) checks.push({ nome: "passou_o_assunto_certo", ok: input.humanoFala.test(resposta?.humano?.motivo ?? ""), detalhe: resposta?.humano?.motivo });
    return checks;
  };
}

/**
 * Live replies. The first ones are the cases the old engine sent to a person without reading the
 * base (the safety regex sees "estoque" or "prazo" and hands over): the answer is in the documents,
 * so handing over counts as a failure.
 */
export const cenariosAoVivo: Cenario[] = [
  {
    id: "estoque_na_base",
    titulo: "Estoque de chapa que está na base (hoje vai pra humano)",
    pedido: contextoVillefer(),
    persona: cliente("boa tarde, vocês tem chapa 3mm 1200x3000 em estoque?"),
    maxTrocas: 1,
    exigeModelo: true,
    verificar: respostaAoVivo({ humano: false, fala: /estoque|temos|sim/i })
  },
  {
    id: "prazo_na_base",
    titulo: "Prazo de entrega que está na base (hoje vai pra humano)",
    pedido: contextoVillefer(),
    persona: cliente("vcs entregam em jaraguá? qual o prazo?"),
    maxTrocas: 1,
    exigeModelo: true,
    verificar: respostaAoVivo({ humano: false, fala: /48/ })
  },
  {
    id: "pagamento_na_base",
    titulo: "Boleto 28 dias, que está na base",
    pedido: contextoVillefer(),
    persona: cliente("aceita boleto 28 dias?"),
    maxTrocas: 1,
    exigeModelo: true,
    verificar: respostaAoVivo({ humano: false, fala: /28|cadastro|CNPJ/i })
  },
  {
    id: "nao_trabalha_na_base",
    titulo: "A base diz que não trabalham com inox: responde, não passa",
    pedido: contextoVillefer(),
    persona: cliente("tem barra redonda de inox 316 de 2 polegadas?"),
    maxTrocas: 1,
    exigeModelo: true,
    verificar: respostaAoVivo({ humano: false, fala: /n[aã]o trabalhamos|inox/i })
  },
  {
    id: "fora_da_base",
    titulo: "Pergunta que a base não responde: passa, com frase específica",
    pedido: contextoVillefer(),
    persona: cliente("vocês emitem certificado de qualidade da usina junto com a nota?"),
    maxTrocas: 1,
    exigeModelo: true,
    verificar: respostaAoVivo({ humano: true, fala: /certificado/i, humanoFala: /certificado/i })
  },
  {
    id: "metade_na_base",
    titulo: "Uma parte na base e outra não: responde uma, passa a outra",
    pedido: contextoVillefer(),
    persona: cliente("qual o prazo pra blumenau? e vocês dão desconto pra 5 toneladas?"),
    maxTrocas: 1,
    exigeModelo: true,
    verificar: respostaAoVivo({ humano: true, fala: /48/, humanoFala: /desconto|tonelada/i })
  },
  {
    id: "papo_social",
    titulo: "Papo sem nada a ver ('dia quente aqui, como tá aí?'): conversa, não busca nem passa",
    pedido: contextoVillefer(),
    persona: cliente("opa, dia quente aqui hoje hein, como tá aí?"),
    maxTrocas: 1,
    exigeModelo: true,
    verificar: (run) => {
      const leitura = run.turnos.flatMap((turno) => turno.resultado.trace).filter((step) => step.fase === "leitura").flatMap((step) => step.detalhe as Array<{ ferramenta: string }>);
      return [
        ...respostaAoVivo({ humano: false })(run),
        { nome: "nao_buscou_na_base", ok: !leitura.some((call) => call.ferramenta === "buscar_na_base"), detalhe: leitura.map((call) => call.ferramenta).join(", ") }
      ];
    }
  },
  {
    id: "papo_e_pergunta",
    titulo: "Papo e pergunta juntos: responde o papo e a pergunta pela base",
    pedido: contextoVillefer(),
    persona: cliente("bom dia! calor demais aqui hoje kkk. vcs entregam em blumenau?"),
    maxTrocas: 1,
    exigeModelo: true,
    verificar: respostaAoVivo({ humano: false, fala: /48 horas/i })
  },
  {
    id: "pediu_pessoa",
    titulo: "Cliente pediu uma pessoa",
    pedido: contextoVillefer(),
    persona: cliente("quero falar com um vendedor por favor"),
    maxTrocas: 1,
    exigeModelo: true,
    verificar: respostaAoVivo({ humano: true, fala: /vendedor/i })
  }
];

const NEGA = /n[aã]o (fornece\w*|trabalha\w*|vende\w*|faz\w*|atende\w*|conseguimos atender|temos)/i;

/**
 * Questions real customers sent the old agent, which handed them to a seller although the company's own
 * base answers them (minimum order, what it does not supply). Run with the base exported from production
 * (HARNESS_BASE_FONTES): a hand-over here is the failure we are measuring.
 */
export function cenariosDaBaseReal(base: BaseDeConhecimento, catalogo?: Catalogo): Cenario[] {
  const pedido = contextoVillefer({
    empresa: { nome: "Villefer", oQueVende: "Distribuidora de aço para indústria e caldeiraria: chapas e laminados (barras, cantoneiras, vigas, perfis), tubos e inox ou alumínio sob encomenda." },
    base,
    catalogo
  });
  const caso = (id: string, titulo: string, mensagens: string[], fala?: RegExp, espera: Parameters<typeof respostaAoVivo>[0] = { humano: false, fala }): Cenario => ({
    id: `base_real_${id}`,
    titulo,
    pedido,
    persona: cliente(mensagens.join("\n")),
    maxTrocas: 1,
    exigeModelo: true,
    verificar: respostaAoVivo(espera)
  });
  return [
    caso("metalon", "Metalon em 4 barras: diz o mínimo de 1.000 kg, não passa", ["Boa tarde vcs vende Metalon qual o valor", "Eu queria 4 barra de 4 metro cada uma barra"], /1\.?000 ?kg|m[ií]nimo/i),
    caso("inox_barra", "Barra redonda de inox: encomenda com mínimo de 300 kg", ["Você trabalha com inox?", "seria uma barra redonda"], /300 ?kg|encomenda/i),
    caso("aco_1045_peca", "Uma peça de 1045 cortada no tamanho: material cortado não fornecem", ["Preciso de uma cotação de aço 1045 trifilado", "Diâmetro 31x295mm 01 peça"], new RegExp(`cort|${NEGA.source}`, "i")),
    caso("tarugo_inox", "Tarugo de inox 316L em pedaço: material cortado não fornecem", ["Bom dia, orçamento para uma tarugo em inox 316L", "D155x80 mm"], new RegExp(`cort|${NEGA.source}`, "i")),
    caso("haste_cromada", "Haste cromada sob medida: peça fabricada não é com eles", ["Haste inox cromada D90 x 536mm"], new RegExp(`fabricad|cort|${NEGA.source}`, "i")),
    caso("corte_chapa", "Peças de chapa cortadas: não fazem corte", ["vcs cortam chapa? preciso de 10 peças 300x500 de 6mm"], new RegExp(`cort|${NEGA.source}`, "i")),
    caso("tela_soldada", "Tela soldada: linha de construção civil", ["1) 400 unidades - Tela Soldada Nervurada Q196 10x10 5.0mm 2.45x6.0m - NBR 7481"], new RegExp(`constru[cç][aã]o civil|${NEGA.source}`, "i")),
    caso("vergalhao", "Barra de 10 mm para viga baldrame: vergalhão de construção civil", ["Quanto ta uma a barra de 10mm 12m", "Barra pra viga baldrame"], new RegExp(`constru[cç][aã]o civil|vergalh|${NEGA.source}`, "i")),
    caso("bucha", "Bucha de ferro fundido: não fornecem", ["Bucha de ferro fundido: Diâmetro externo 170mm x 120mm x 485mm"], NEGA),
    caso("telha", "Telha de alumínio: não fornecem telhas", ["Telha de alumínio"], NEGA),
    caso("saudacao", "Só um bom dia: cumprimenta, não passa", ["Bom dia! Tudo bem?"]),
    // These need the minimums and cities the company gave on 16/10 (HARNESS_BASE_PROPOSTA=1).
    caso("inox_250", "250 kg de inox, perto do mínimo: não recusa, o vendedor decide", ["preciso de 250 kg de barra redonda inox 304, vcs fazem?"], undefined, { fala: /300|vendedor/i, naoFala: /n[aã]o (conseguimos|atendemos|fazemos)|pequeno demais/i }),
    caso("regiao_joinville", "Entrega em Joinville: confirma, não passa", ["vcs entregam em joinville?"], /sim|entregamos|atendemos/i),
    caso("regiao_pomerode", "Entrega em Pomerode: confirma, não passa", ["sou de pomerode, vcs atendem aqui?"], /sim|entregamos|atendemos/i),
    caso("regiao_bahia", "Entrega na Bahia: diz que não atendem, não passa", ["vcs entregam em salvador bahia?"], NEGA),
    // This one needs the catalogue (HARNESS_CATALOGO): 10 × 6 m × 1,82 kg/m is about 109 kg, far from 1.000 kg.
    caso("metalon_peso", "10 barras de metalon 40x40: calcula uns 109 kg e diz o mínimo de 1.000 kg", ["quero 10 barras de metalon 40x40 parede 1,5 de 6 metros, da pra fazer?"], undefined, { humano: false, fala: /1[01]\d ?(kg|quilos)/i }),
    caso("regiao_lages", "Cidade fora da lista: não promete nem recusa, o vendedor confirma", ["entregam em lages?"], undefined, { fala: /vendedor/i, naoFala: new RegExp(`^sim|${NEGA.source}`, "i") })
  ];
}

/**
 * Labeled cases in the format of scripts/evaluate-followup-brain.ts (one JSON per line: caseId, expected,
 * messages[label, body, createdAt]) become scenarios, so the same real conversations score both engines.
 */
export function cenariosDeCasos(casos: Array<{ caseId: string; expected: string; messages: Array<{ label: "cliente" | "atendente"; body: string | null; createdAt: string }> }>): Cenario[] {
  const esperado: Record<string, string[]> = {
    waiting_customer: ["cobrar_pendencia"],
    waiting_company: ["lembrete_vendedor"],
    closed: QUIETO,
    no_pending: QUIETO
  };
  return casos.map((caso) => ({
    id: `caso_${caso.caseId}`,
    titulo: `Caso real ${caso.caseId} (${caso.expected})`,
    pedido: contextoVillefer(),
    persona: silencioso,
    historicoInicial: caso.messages.map((message) => ({
      autor: message.label === "cliente" ? "contato" as const : "humano" as const,
      texto: message.body ?? "[mensagem sem texto]",
      em: message.createdAt
    })),
    exigeModelo: true,
    verificar: espera({ jogadas: esperado[caso.expected] ?? QUIETO })
  }));
}
