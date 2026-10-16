import type { Check, Scenario, ScenarioRun } from "../../simulador/simulador.js";
import { conversa } from "../atendimento/cenarios.js";
import type { CampanhaDeProspeccao, FichaDoLead } from "./tipos.js";

type Cenario = Scenario<FichaDoLead, CampanhaDeProspeccao>;
type Run = ScenarioRun<FichaDoLead, CampanhaDeProspeccao>;

export const campanhaBase = (empresa: string, overrides: Partial<CampanhaDeProspeccao> = {}): CampanhaDeProspeccao => ({
  nossaEmpresa: { nome: "Prymeira", oQueFazemos: "Colocamos um atendente com IA no WhatsApp da empresa, que responde na hora e devolve o orçamento pronto para a equipe." },
  objetivo: "marcar uma call de 15 minutos para mostrar funcionando",
  contextoDaOferta: "Funciona no número que a empresa já usa. A equipe continua vendo e assumindo qualquer conversa. Preço depende do volume de conversas e é passado na call.",
  exemploDeDor: "Quando a loja enche, o WhatsApp fica esperando; a IA responde na hora e devolve o orçamento pronto.",
  lead: { empresa, nomeContato: null },
  maxRetomadas: 2,
  ...overrides
});

const ABERTURA = "E: Oi, tudo bem? Aqui é da Prymeira. Vi que vocês atendem muitos clientes pelo WhatsApp. Quem cuida do atendimento por aí?";
const roteiro = (...mensagens: Array<string | null>) => ({ tipo: "roteiro" as const, responder: ({ vez }: { vez: number }) => mensagens[vez] ?? null });
const enviados = (run: Run) => run.historico.filter((message) => message.autor === "agente").slice(1).map((message) => message.texto);
const jogadas = (run: Run) => run.turnos.map((turno) => turno.resultado.jogada?.tipo ?? "—");

function comuns(run: Run): Check[] {
  const textos = enviados(run);
  return [
    { nome: "sem_como_posso_ajudar", ok: !textos.some((texto) => /como posso (te )?ajudar/i.test(texto)), detalhe: textos.join(" | ") },
    { nome: "nunca_foi_para_humano_sem_motivo", ok: !run.humano || /aceitou|indica/i.test(run.humano.motivo), detalhe: run.humano?.motivo }
  ];
}

/** The conversations of 13/10 (analise-dia-13-10.md), rewritten from the analysis, plus the gaps it found. */
export const cenarios: Cenario[] = [
  {
    id: "jav_menu",
    titulo: "Menu automático, duas vezes (JAV)",
    pedido: campanhaBase("JAV Ferragens"),
    historicoInicial: conversa(ABERTURA),
    persona: roteiro("Olá! Digite 1 para Vendas, 2 para Financeiro, 3 para Outros assuntos", "Opção inválida. Digite 1 para Vendas, 2 para Financeiro"),
    maxTrocas: 2,
    verificar: (run) => [...comuns(run), { nome: "nao_respondeu_ao_robo", ok: enviados(run).length === 0, detalhe: enviados(run).join(" | ") }]
  },
  {
    id: "tecville_boas_vindas",
    titulo: "Boas-vindas automáticas (Tecville)",
    pedido: campanhaBase("Tecville"),
    historicoInicial: conversa(ABERTURA),
    persona: roteiro("Olá! Seja bem-vindo à Tecville. Em breve um de nossos atendentes irá te responder."),
    maxTrocas: 1,
    verificar: (run) => [...comuns(run), { nome: "nao_respondeu_ao_robo", ok: enviados(run).length === 0, detalhe: enviados(run).join(" | ") }]
  },
  {
    id: "topprime_assistente_virtual",
    titulo: "Assistente virtual se apresenta com nome (Top Prime)",
    pedido: campanhaBase("Top Prime"),
    historicoInicial: conversa(ABERTURA),
    persona: roteiro("Olá, eu sou a Tatiani, assistente virtual da Top Prime! Em que posso ajudar?"),
    maxTrocas: 1,
    verificar: (run) => [...comuns(run),
      { nome: "nao_respondeu_ao_robo", ok: enviados(run).length === 0, detalhe: enviados(run).join(" | ") },
      { nome: "nao_chamou_o_robo_pelo_nome", ok: !enviados(run).some((texto) => /tatiani/i.test(texto)) }]
  },
  {
    id: "recusa_explicita",
    titulo: "Recusa clara depois da explicação (Tecfilter)",
    pedido: campanhaBase("Tecfilter"),
    historicoInicial: conversa(ABERTURA),
    persona: roteiro("não temos interesse, obrigado"),
    maxTrocas: 2,
    verificar: (run) => {
      const textos = enviados(run);
      return [...comuns(run),
        { nome: "agradeceu_uma_vez", ok: textos.length === 1 && !textos[0].includes("?"), detalhe: textos.join(" | ") },
        { nome: "encerrou", ok: run.ficha.etapa === "encerrado" }];
    }
  },
  {
    id: "debora_recusa_educada",
    titulo: "Recusa educada da Débora (Casa Mil)",
    pedido: campanhaBase("Casa Mil Ltda"),
    historicoInicial: conversa(ABERTURA),
    persona: roteiro("Oi, aqui é a Débora. Somos 3 pessoas atendendo loja e WhatsApp ao mesmo tempo", "No momento não, mas muito obrigada"),
    maxTrocas: 3,
    verificar: (run) => {
      const textos = enviados(run);
      const ultima = textos.at(-1) ?? "";
      return [...comuns(run),
        { nome: "agradeceu_pelo_nome", ok: /d[ée]bora/i.test(ultima) && !ultima.includes("?"), detalhe: ultima },
        { nome: "nao_chamou_de_casa_mil", ok: !textos.some((texto) => /oi,? casa mil/i.test(texto)), detalhe: textos.join(" | ") },
        { nome: "encerrou", ok: run.ficha.etapa === "encerrado" }];
    }
  },
  {
    id: "recepcao_nao_decide",
    titulo: "Recepção que não decide pede o responsável",
    pedido: campanhaBase("Metalúrgica Boa Vista"),
    historicoInicial: conversa(ABERTURA),
    persona: roteiro("aqui é a recepção, quem cuida disso é o sócio"),
    maxTrocas: 1,
    verificar: (run) => [...comuns(run), { nome: "pediu_o_responsavel", ok: jogadas(run).includes("pedir_responsavel") && /nome|contato/i.test(enviados(run)[0] ?? ""), detalhe: enviados(run)[0] }]
  },
  {
    id: "nunca_respondeu",
    titulo: "Lead que nunca respondeu não recebe retomada",
    pedido: campanhaBase("Trevo Metais | Aços | Metais | Corrimão"),
    historicoInicial: conversa(ABERTURA),
    persona: roteiro(null),
    maxTrocas: 2,
    verificar: (run) => [...comuns(run), { nome: "ficou_quieto", ok: enviados(run).length === 0, detalhe: jogadas(run).join(",") }]
  },
  {
    id: "meccatus_achou_que_e_material",
    titulo: "Lead acha que vendemos material: explica e puxa o próximo passo (Meccatus)",
    pedido: campanhaBase("Meccatus"),
    historicoInicial: conversa(ABERTURA),
    persona: { tipo: "llm", papel: "Você é o comprador da Meccatus, uma indústria de máquinas. Acha que a mensagem é de um fornecedor de material e pergunta 'qual tipo de material?'. Depois de entender, fica curioso mas ocupado.", segredos: "A equipe de vendas tem 2 pessoas e demora para responder orçamento no WhatsApp." },
    maxTrocas: 3,
    exigeModelo: true,
    verificar: (run) => {
      const primeira = enviados(run)[0] ?? "";
      return [...comuns(run),
        { nome: "explicou_sem_falar_de_material", ok: primeira.length > 0 && !/qual material|tipo de material/i.test(primeira), detalhe: primeira },
        { nome: "terminou_com_proximo_passo", ok: /\?/.test(primeira), detalhe: primeira }];
    }
  },
  {
    id: "pergunta_preco",
    titulo: "Pergunta de preço não deixa o João mudo nem inventa valor",
    pedido: campanhaBase("Ferragens Sul"),
    historicoInicial: conversa(ABERTURA),
    persona: roteiro("sou eu que cuido. quanto custa isso?"),
    maxTrocas: 1,
    exigeModelo: true,
    verificar: (run) => {
      const texto = enviados(run)[0] ?? "";
      return [...comuns(run),
        { nome: "respondeu", ok: texto.length > 0, detalhe: texto || "(mudo)" },
        { nome: "sem_valor", ok: !/R\$|\d+\s*reais/i.test(texto), detalhe: texto },
        { nome: "puxou_a_call", ok: /call|conversa|15 minutos|mostrar/i.test(texto), detalhe: texto }];
    }
  },
  {
    id: "arsul_indicou",
    titulo: "Lead indica o responsável com telefone (Arsul)",
    pedido: campanhaBase("Arsul"),
    historicoInicial: conversa(ABERTURA),
    persona: roteiro("quem vê isso é o Rafael do comercial, fala com ele no 47 99812-1111"),
    maxTrocas: 1,
    exigeModelo: true,
    verificar: (run) => [...comuns(run), { nome: "passou_a_indicacao", ok: /rafael/i.test(run.humano?.motivo ?? ""), detalhe: run.humano?.motivo }]
  },
  {
    id: "aceitou_call",
    titulo: "Lead interessado aceita a call",
    pedido: campanhaBase("Aço Forte"),
    historicoInicial: conversa(ABERTURA),
    persona: { tipo: "llm", papel: "Você é o dono da Aço Forte, uma distribuidora pequena. Você perde venda porque demora para responder o WhatsApp. Se te propuserem uma call curta, aceite e diga 'amanhã às 10h pode ser'.", segredos: "Recebe uns 40 pedidos de orçamento por dia no WhatsApp." },
    maxTrocas: 4,
    exigeModelo: true,
    verificar: (run) => [...comuns(run),
      { nome: "chegou_no_objetivo", ok: run.ficha.etapa === "objetivo_aceito", detalhe: run.ficha.etapa },
      { nome: "avisou_o_time", ok: /aceitou/i.test(run.humano?.motivo ?? ""), detalhe: run.humano?.motivo }]
  }
];
