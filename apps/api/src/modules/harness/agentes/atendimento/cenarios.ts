import type { HarnessMessage } from "../../core/types.js";
import type { Check, Scenario, ScenarioRun } from "../../simulador/simulador.js";
import { semelhanca } from "./regras.js";
import type { ContextoDoAtendimento, FichaDoAtendimento } from "./tipos.js";

type Cenario = Scenario<FichaDoAtendimento, ContextoDoAtendimento>;
type Run = ScenarioRun<FichaDoAtendimento, ContextoDoAtendimento>;

export const contextoVillefer = (overrides: Partial<ContextoDoAtendimento> = {}): ContextoDoAtendimento => ({
  empresa: { nome: "Villefer", oQueVende: "Distribuidora de aço: chapas, perfis, tubos, barras e telhas, com corte sob medida." },
  maxFollowups: 3,
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
    verificar: espera({ jogadas: ["encerrada", "nada_aberto"] })
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
