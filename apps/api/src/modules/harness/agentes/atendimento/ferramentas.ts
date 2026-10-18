import { z } from "zod";
import type { HarnessMessage, HarnessTool } from "../../core/types.js";
import { ferramentasDoCatalogo } from "./catalogo.js";
import { lacunasDaBase } from "./cobertura.js";
import { frasesDe, renderFicha } from "./ficha.js";
import type { ContextoDoAtendimento, FichaDoAtendimento, Prova } from "./tipos.js";

type Tool<Args> = HarnessTool<FichaDoAtendimento, ContextoDoAtendimento, Args>;

const PROVA_PROPS = {
  mensagem: { type: "integer", description: "Número da mensagem, entre colchetes na conversa numerada." },
  trecho: { type: "string", description: "Palavras EXATAS copiadas dessa mensagem que provam o que você está registrando." }
};
const provaArgs = { mensagem: z.number().int().min(0), trecho: z.string().trim().min(2) };

const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The proof rule, in code: the quote must really be in that message. A finding the model cannot quote
 * is not recorded, which is what keeps "pending items" from being invented.
 */
export function conferirProva(historico: HarnessMessage[], mensagem: number, trecho: string): Prova {
  const message = historico[mensagem];
  if (!message) throw new Error(`a mensagem [${mensagem}] não existe; a conversa vai de [0] a [${historico.length - 1}].`);
  if (!normalize(message.texto).includes(normalize(trecho))) {
    throw new Error(`o trecho "${trecho}" não está na mensagem [${mensagem}]. Copie as palavras exatas dela, ou não registre.`);
  }
  return { mensagem, trecho: trecho.trim().slice(0, 160) };
}

const ok = (ficha: FichaDoAtendimento) => `Registrado. Ficha agora:\n${renderFicha(ficha)}`;

const contatoArgs = z.object({
  tipo: z.enum(["cliente", "colega", "pessoal", "fornecedor", "transportadora", "indefinido"]),
  mensagem: provaArgs.mensagem.nullable().optional(),
  trecho: provaArgs.trecho.nullable().optional()
});
const classificarContato: Tool<z.infer<typeof contatoArgs>> = {
  name: "classificar_contato",
  description: "Diz quem é o contato para a empresa. cliente: cliente, lead ou empresa prospectada. colega: alguém da própria empresa. pessoal: família, amigo, conversa pessoal. fornecedor: alguém de quem a EMPRESA compra (a empresa pede preço, estoque ou prazo para ele). transportadora: frete, motorista. indefinido: sem sinal claro. Qualquer tipo que não seja cliente ou indefinido precisa de prova.",
  parameters: {
    type: "object",
    properties: { tipo: { type: "string", enum: ["cliente", "colega", "pessoal", "fornecedor", "transportadora", "indefinido"] }, ...nullableProva() },
    required: ["tipo"],
    additionalProperties: false
  },
  schema: contatoArgs,
  execute(args, context) {
    const needsProof = args.tipo !== "cliente" && args.tipo !== "indefinido";
    if (needsProof && (args.mensagem == null || !args.trecho)) throw new Error(`para dizer que o contato é ${args.tipo}, cite a mensagem e o trecho que mostram isso.`);
    const prova = args.mensagem != null && args.trecho ? conferirProva(context.historico, args.mensagem, args.trecho) : null;
    const ficha = { ...context.ficha, contato: { tipo: args.tipo, prova } };
    context.setFicha(ficha);
    return ok(ficha);
  }
};

const abrirArgs = z.object({
  dono: z.enum(["cliente", "empresa"]),
  descricao: z.string().trim().min(5).max(200),
  ...provaArgs,
  contatoMensagem: provaArgs.mensagem.nullable().optional(),
  contatoTrecho: provaArgs.trecho.nullable().optional()
});
const abrirPendencia: Tool<z.infer<typeof abrirArgs>> = {
  name: "abrir_pendencia",
  description: [
    "Registra algo que ficou em aberto e de quem é a vez.",
    "dono=cliente (vira follow-up): uma venda parou do lado do cliente ANTES de fechar. Ele pediu um orçamento ou produto e sumiu: não respondeu ao orçamento, não respondeu a uma pergunta da empresa para a cotação seguir ('me manda o comprimento'), ficou de mandar um dado, ou disse 'vou ver', 'vou falar com meu sócio'.",
    "dono=empresa (vira lembrete para o vendedor): o cliente pediu ou perguntou algo e a empresa ainda não deu a resposta ('qual o valor?', 'me manda o certificado', 'dá pra entregar amanhã?', 'cadê o caminhão?'). 'Vou consultar' não é resposta; uma data ou um valor é.",
    "A descrição é uma frase curta e concreta, com o item ou o assunto. mensagem/trecho: a mensagem que prova a pendência.",
    "contatoMensagem/contatoTrecho: a mensagem DO CONTATO que mostra o interesse (dono=cliente: o pedido de orçamento ou produto, ou o 'vou ver') ou a pergunta sem resposta (dono=empresa). Se mensagem/trecho já é do contato, pode repetir."
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      dono: { type: "string", enum: ["cliente", "empresa"] },
      descricao: { type: "string" },
      ...PROVA_PROPS,
      contatoMensagem: { type: ["integer", "null"], description: "Número da mensagem do CONTATO com o pedido ou a pergunta." },
      contatoTrecho: { type: ["string", "null"], description: "Palavras EXATAS dessa mensagem do contato." }
    },
    required: ["dono", "descricao", "mensagem", "trecho", "contatoMensagem", "contatoTrecho"],
    additionalProperties: false
  },
  schema: abrirArgs,
  execute(args, context) {
    if (!context.historico.some((message) => message.autor === "contato")) {
      throw new Error("o contato nunca respondeu nesta conversa: uma mensagem só da empresa não deixa pendência.");
    }
    const prova = conferirProva(context.historico, args.mensagem, args.trecho);
    const doContato = provaDoContato(context.historico, args, prova);
    const id = `p${context.ficha.pendencias.length + 1}`;
    const ficha = {
      ...context.ficha,
      pendencias: [...context.ficha.pendencias, { id, dono: args.dono, descricao: args.descricao, prova, doContato, status: "aberta" as const, resolvidaPor: null }]
    };
    context.setFicha(ficha);
    return ok(ficha);
  }
};

/**
 * A follow-up or a reminder exists only because of something the contact said: interest in a sale that
 * stopped, or a question still unanswered. An offer the company sent on its own, or a task of its own
 * after the sale ("vou separar", "entrego amanhã"), has no such message and leaves nothing pending.
 */
function provaDoContato(historico: HarnessMessage[], args: z.infer<typeof abrirArgs>, prova: Prova): Prova {
  const doContato = args.contatoMensagem != null && args.contatoTrecho
    ? conferirProva(historico, args.contatoMensagem, args.contatoTrecho)
    : historico[prova.mensagem]?.autor === "contato" ? prova : null;
  const exemplo = args.dono === "empresa" ? "a pergunta ou o pedido que ficou sem resposta" : "o pedido de orçamento ou produto, ou o 'vou ver'";
  if (!doContato) throw new Error(`cite em contatoMensagem/contatoTrecho a mensagem do contato com ${exemplo}. Sem ela não é pendência.`);
  if (historico[doContato.mensagem]?.autor !== "contato") {
    throw new Error(`a mensagem [${doContato.mensagem}] não é do contato. Cite a mensagem do contato com ${exemplo}; se ele não pediu nem perguntou nada, não é pendência.`);
  }
  return doContato;
}

const resolverArgs = z.object({ id: z.string().min(1), ...provaArgs });
const resolverPendencia: Tool<z.infer<typeof resolverArgs>> = {
  name: "resolver_pendencia",
  description: "Fecha uma pendência que a conversa já resolveu (o cliente respondeu, a empresa cumpriu, o assunto morreu). Cite a mensagem posterior que mostra isso.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Id da pendência na ficha, ex.: p1." }, ...PROVA_PROPS },
    required: ["id", "mensagem", "trecho"],
    additionalProperties: false
  },
  schema: resolverArgs,
  execute(args, context) {
    const item = context.ficha.pendencias.find((pendencia) => pendencia.id === args.id);
    if (!item) throw new Error(`pendência ${args.id} não existe.`);
    if (args.mensagem < item.prova.mensagem) throw new Error(`a prova de que ${args.id} foi resolvida tem de vir depois da mensagem [${item.prova.mensagem}].`);
    const resolvidaPor = conferirProva(context.historico, args.mensagem, args.trecho);
    const ficha = {
      ...context.ficha,
      pendencias: context.ficha.pendencias.map((pendencia) => pendencia.id === args.id ? { ...pendencia, status: "resolvida" as const, resolvidaPor } : pendencia)
    };
    context.setFicha(ficha);
    return ok(ficha);
  }
};

const motivoArgs = z.object({ motivo: z.string().trim().min(3).max(200), ...provaArgs });
const marcarEncerrada: Tool<z.infer<typeof motivoArgs>> = {
  name: "marcar_encerrada",
  description: "A demanda terminou: pedido fechado e confirmado, pagamento ou entrega combinados e concluídos, cliente disse que não tem interesse ou comprou em outro lugar, pediu para não ser contatado, ou agradeceu depois de ter o que precisava. 'Ok' sozinho depois de uma proposta NÃO é encerramento.",
  parameters: { type: "object", properties: { motivo: { type: "string" }, ...PROVA_PROPS }, required: ["motivo", "mensagem", "trecho"], additionalProperties: false },
  schema: motivoArgs,
  execute(args, context) {
    const ficha = { ...context.ficha, encerrada: { motivo: args.motivo, prova: conferirProva(context.historico, args.mensagem, args.trecho) } };
    context.setFicha(ficha);
    return ok(ficha);
  }
};

const marcarEmAndamento: Tool<z.infer<typeof motivoArgs>> = {
  name: "marcar_em_andamento",
  description: "Pós-venda andando: pedido fechado com separação, entrega ou faturamento combinados ('vou separar', 'chega segunda'), ou retirada e entrega acontecendo agora ('tô chegando', localização enviada, 'já saiu'). Não há o que cobrar do cliente nem lembrar o vendedor nesse momento.",
  parameters: { type: "object", properties: { motivo: { type: "string" }, ...PROVA_PROPS }, required: ["motivo", "mensagem", "trecho"], additionalProperties: false },
  schema: motivoArgs,
  execute(args, context) {
    const ficha = { ...context.ficha, emAndamento: { motivo: args.motivo, prova: conferirProva(context.historico, args.mensagem, args.trecho) } };
    context.setFicha(ficha);
    return ok(ficha);
  }
};

const indicadoArgs = z.object({ nome: z.string().trim().min(2), telefone: z.string().trim().min(8).nullable().optional(), ...provaArgs });
const registrarIndicado: Tool<z.infer<typeof indicadoArgs>> = {
  name: "registrar_contato_indicado",
  description: "O contato passou o contato de outra pessoa para tratar do assunto (o comprador, o responsável por compras). A vez passa a ser da empresa: o vendedor deve falar com essa pessoa.",
  parameters: {
    type: "object",
    properties: { nome: { type: "string" }, telefone: { type: ["string", "null"] }, ...PROVA_PROPS },
    required: ["nome", "mensagem", "trecho"],
    additionalProperties: false
  },
  schema: indicadoArgs,
  execute(args, context) {
    const ficha = { ...context.ficha, indicado: { nome: args.nome, telefone: args.telefone ?? null, prova: conferirProva(context.historico, args.mensagem, args.trecho) } };
    context.setFicha(ficha);
    return ok(ficha);
  }
};

function nullableProva() {
  return {
    mensagem: { type: ["integer", "null"], description: PROVA_PROPS.mensagem.description },
    trecho: { type: ["string", "null"], description: PROVA_PROPS.trecho.description }
  };
}

export const ferramentasDoAnalista = [classificarContato, abrirPendencia, resolverPendencia, marcarEncerrada, marcarEmAndamento, registrarIndicado];

/* ---------- Live conversation: questions answered from the knowledge base ---------- */

const perguntaArgs = z.object({ texto: z.string().trim().min(3).max(300) });
const registrarPergunta: Tool<z.infer<typeof perguntaArgs>> = {
  name: "registrar_pergunta",
  description: "Registra cada pergunta ou pedido de informação sobre a empresa, os produtos ou o pedido na ÚLTIMA mensagem do contato (preço, estoque, prazo, frete, pagamento, medida, se vocês têm um produto...). Uma chamada por pergunta. Conversa social (\"tudo bem?\", \"como tá aí?\", o tempo) não se registra.",
  parameters: { type: "object", properties: { texto: { type: "string", description: "A pergunta, com as palavras do contato." } }, required: ["texto"], additionalProperties: false },
  schema: perguntaArgs,
  execute(args, context) {
    // "Como tá aí?" registered as a question goes to the base, finds nothing and is handed to a seller.
    const texto = normalize(args.texto);
    if (PAPO_SOCIAL.test(texto) && !ASSUNTO_DO_NEGOCIO.test(texto) && !/\d/.test(texto)) {
      throw new Error("isso é conversa social, não pergunta sobre a empresa ou o pedido: não registre. Se a mensagem também tiver uma pergunta de negócio, registre só ela.");
    }
    const id = `q${context.ficha.perguntas.length + 1}`;
    const ficha = { ...context.ficha, perguntas: [...context.ficha.perguntas, { id, texto: args.texto, status: "aberta" as const, resposta: null, buscas: 0 }] };
    context.setFicha(ficha);
    return `Pergunta ${id} registrada. Agora procure a resposta com buscar_na_base.`;
  }
};

/** The model sometimes writes "1", "pergunta-1" or "p1" for "q1"; all mean the same registered question. */
const idDaPergunta = z.string().trim().min(1).transform((id) => (/^(\d+|pergunta[-_ ]?\d+|p\d+)$/i.test(id) ? `q${id.match(/\d+/)![0]}` : id));

const basesMostradas = new WeakSet<object>();
const buscaArgs = z.object({ perguntaId: idDaPergunta, consulta: z.string().trim().min(2).max(200) });
const buscarNaBase: Tool<z.infer<typeof buscaArgs>> = {
  name: "buscar_na_base",
  description: "Procura a resposta de uma pergunta nos documentos aprovados da empresa (catálogo, políticas, perguntas frequentes). Pode buscar mais de uma vez com palavras diferentes.",
  parameters: {
    type: "object",
    properties: { perguntaId: { type: "string" }, consulta: { type: "string", description: "Palavras-chave da pergunta (produto, medida, cidade, assunto)." } },
    required: ["perguntaId", "consulta"],
    additionalProperties: false
  },
  schema: buscaArgs,
  async execute(args, context) {
    const pergunta = context.ficha.perguntas.find((item) => item.id === args.perguntaId);
    if (!pergunta) throw new Error(`pergunta ${args.perguntaId} não existe; registre com registrar_pergunta.`);
    const todos = context.pedido.base?.todos?.();
    // The whole base goes once per reading (the same history array); a later message reads it again.
    if (todos && basesMostradas.has(context.historico)) {
      context.setFicha({ ...context.ficha, perguntas: context.ficha.perguntas.map((item) => item.id === pergunta.id ? { ...item, buscas: item.buscas + 1 } : item) });
      return "Os documentos inteiros da empresa já estão acima, nos resultados de buscar_na_base. Releia: use responder_pergunta com o trecho que responde (inclusive os que dizem o que a empresa não fornece ou o pedido mínimo), ou marcar_sem_base se nenhum responde.";
    }
    const trechos = todos ?? (context.pedido.base ? await context.pedido.base.buscar(args.consulta) : []);
    const ficha = {
      ...context.ficha,
      perguntas: context.ficha.perguntas.map((item) => item.id === pergunta.id ? { ...item, buscas: item.buscas + 1 } : item),
      trechosVistos: { ...context.ficha.trechosVistos, ...Object.fromEntries(trechos.map((trecho) => [trecho.id, trecho.texto])) }
    };
    context.setFicha(ficha);
    if (todos) basesMostradas.add(context.historico);
    if (!trechos.length) return "Nada encontrado. Tente outras palavras; se ainda assim não houver, use marcar_sem_base.";
    const lista = trechos.map((trecho) => `[${trecho.id}] ${trecho.titulo}: ${trecho.texto}`).join("\n");
    return todos ? `A base é pequena: estes são TODOS os documentos da empresa. Procure aqui a resposta, inclusive o que ela não fornece e os pedidos mínimos.\n${lista}` : lista;
  }
};

/**
 * The citation grows to the whole sentences that hold it. "vergalhões da linha de construção civil" cut out
 * of "NÃO FORNECE: …; vergalhões da linha de construção civil" reads as a yes; seen twice in the shadow
 * rerun of 16/10. A citation with "..." is several pieces of the same passage, in order.
 */
export function citacaoInteira(trecho: string, citacao: string): string | null {
  const pedacos = citacao.split(/\s*(?:\.{3}|…)\s*/).map(normalize).filter(Boolean);
  if (!pedacos.length) return null;
  const contem = (texto: string) => {
    let desde = 0;
    for (const pedaco of pedacos) {
      const achou = texto.indexOf(pedaco, desde);
      if (achou < 0) return false;
      desde = achou + pedaco.length;
    }
    return true;
  };
  if (!contem(normalize(trecho))) return null;
  const frases = frasesDe(trecho);
  for (let tamanho = 1; tamanho <= frases.length; tamanho += 1) {
    for (let inicio = 0; inicio + tamanho <= frases.length; inicio += 1) {
      const janela = frases.slice(inicio, inicio + tamanho).join("");
      if (contem(normalize(janela))) return janela.trim();
    }
  }
  return trecho.trim();
}

const respostaArgs = z.object({ perguntaId: idDaPergunta, trechoId: z.string().min(1), citacao: z.string().trim().min(3) });
const responderPergunta: Tool<z.infer<typeof respostaArgs>> = {
  name: "responder_pergunta",
  description: "Marca a pergunta como respondida pela base, citando as palavras EXATAS do trecho que responde. Use só quando o trecho responde de verdade o que foi perguntado.",
  parameters: {
    type: "object",
    properties: { perguntaId: { type: "string" }, trechoId: { type: "string" }, citacao: { type: "string", description: "Palavras exatas do trecho." } },
    required: ["perguntaId", "trechoId", "citacao"],
    additionalProperties: false
  },
  schema: respostaArgs,
  execute(args, context) {
    const texto = context.ficha.trechosVistos[args.trechoId];
    if (!texto) throw new Error(`o trecho ${args.trechoId} não apareceu em nenhuma busca.`);
    const inteira = citacaoInteira(texto, args.citacao);
    if (!inteira) throw new Error(`a citação não está no trecho ${args.trechoId}. Copie as palavras exatas.`);
    const nova = { trechoId: args.trechoId, citacao: inteira };
    // A second passage adds to the answer ("we supply it" and then the minimum, the weight) instead of replacing it.
    const ficha = {
      ...context.ficha,
      perguntas: context.ficha.perguntas.map((item) => {
        if (item.id !== args.perguntaId) return item;
        if (item.status !== "respondida" || !item.resposta) return { ...item, status: "respondida" as const, resposta: nova };
        if ([item.resposta, ...(item.maisRespostas ?? [])].some((outra) => outra.trechoId === nova.trechoId && outra.citacao === nova.citacao)) return item;
        return { ...item, maisRespostas: [...(item.maisRespostas ?? []), nova] };
      })
    };
    context.setFicha(ficha);
    return ok(ficha);
  }
};

const semBaseArgs = z.object({ perguntaId: idDaPergunta });
const marcarSemBase: Tool<z.infer<typeof semBaseArgs>> = {
  name: "marcar_sem_base",
  description: "Marca que os documentos não respondem a pergunta. Só depois de buscar. Fica pendente no resumo interno; continue coletando até o pedido estar qualificado ou haver impedimento real.",
  parameters: { type: "object", properties: { perguntaId: { type: "string" } }, required: ["perguntaId"], additionalProperties: false },
  schema: semBaseArgs,
  execute(args, context) {
    const pergunta = context.ficha.perguntas.find((item) => item.id === args.perguntaId);
    if (!pergunta) throw new Error(`pergunta ${args.perguntaId} não existe.`);
    if (pergunta.buscas === 0) throw new Error("busque na base antes (buscar_na_base). Só marque sem base depois de procurar.");
    const ficha = { ...context.ficha, perguntas: context.ficha.perguntas.map((item) => item.id === pergunta.id ? { ...item, status: "sem_base" as const } : item) };
    context.setFicha(ficha);
    return ok(ficha);
  }
};

const pediuPessoa: Tool<Record<string, never>> = {
  name: "cliente_pediu_pessoa",
  description: "O contato pediu claramente para falar com uma pessoa, vendedor ou atendente humano.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  execute(_args, context) {
    context.setFicha({ ...context.ficha, pediuPessoa: true });
    return "Registrado.";
  }
};

const anexoArgs = z.object({ anexoId: z.string().trim().min(1) });
const enviarAnexo: Tool<z.infer<typeof anexoArgs>> = {
  name: "enviar_anexo",
  description: "Anexa à resposta um arquivo aprovado pela empresa (o catálogo em PDF), quando o contato pede para ver ou receber o catálogo. Só arquivos da lista; nunca sem o contato pedir.",
  parameters: {
    type: "object",
    properties: { anexoId: { type: "string", description: "Id do arquivo na lista de anexos aprovados." } },
    required: ["anexoId"],
    additionalProperties: false
  },
  schema: anexoArgs,
  execute(args, context) {
    const anexos = context.pedido.anexos ?? [];
    const anexo = anexos.find((item) => item.id === args.anexoId);
    if (!anexo) throw new Error(anexos.length ? `não existe o anexo ${args.anexoId}. Aprovados: ${anexos.map((item) => `${item.id} (${item.titulo})`).join(", ")}.` : "esta empresa não tem arquivo aprovado para envio. Não diga que vai mandar.");
    if ((context.ficha.anexosDaVez ?? []).includes(anexo.id)) return `${anexo.titulo} já vai anexado nesta resposta.`;
    context.setFicha({ ...context.ficha, anexosDaVez: [...(context.ficha.anexosDaVez ?? []), anexo.id] });
    return `${anexo.titulo} vai anexado nesta resposta.`;
  }
};

const prequalificacaoArgs = z.object({
  situacao: z.enum(["coletando", "pronta", "impedida"]),
  resumo: z.string().trim().min(1).max(2000),
  faltantes: z.array(z.string().trim().min(1)).max(12),
  divergencias: z.array(z.string().trim().min(1)).max(12)
});
const registrarPrequalificacao: Tool<z.infer<typeof prequalificacaoArgs>> = {
  name: "registrar_prequalificacao",
  description: "Atualiza o resumo INTERNO para quem preparar o orçamento, os dados ainda faltantes e divergências (especificação sem fonte, abaixo do mínimo, frete/preço não definido). Coletando enquanto faltar dado necessário. Pronta apenas com pedido e condições aplicáveis qualificados, logística e cadastro conforme a base. Impedida só se não houver como avançar sem decisão humana, não por qualquer especificação a conferir depois. Não informa o cliente nem cria cotação.",
  parameters: {type:"object",properties:{situacao:{type:"string",enum:["coletando","pronta","impedida"]},resumo:{type:"string"},faltantes:{type:"array",items:{type:"string"}},divergencias:{type:"array",items:{type:"string"}}},required:["situacao","resumo","faltantes","divergencias"],additionalProperties:false},
  schema: prequalificacaoArgs,
  execute(args,context) {
    if(args.situacao === "pronta" && args.faltantes.length) throw new Error("Ainda há dados faltantes: continue coletando antes de concluir.");
    context.setFicha({...context.ficha,prequalificacao:args});
    return "Pré-qualificação interna atualizada. Não anuncie vendedor/avaliação/confirmação durante a coleta.";
  }
};

export const ferramentasDeLeitura = [registrarPergunta, buscarNaBase, ...ferramentasDoCatalogo, responderPergunta, marcarSemBase, pediuPessoa, enviarAnexo, registrarPrequalificacao];

const PALAVRAS_VAZIAS = new Set(["voces", "vcs", "tem", "qual", "quais", "para", "pra", "com", "que", "uma", "um", "dos", "das", "aceita", "aceitam", "fazem", "faz"]);
const palavras = (text: string) => new Set((normalize(text).match(/[a-z0-9,]{3,}/g) ?? []).filter((word) => !PALAVRAS_VAZIAS.has(word)));
/**
 * Words of a business question. The nudge fires only with one of them, so small talk ("dia quente aqui,
 * como tá aí?") never gets pushed into the base, where it would end as "no answer" and go to a person.
 */
const PAPO_SOCIAL = /\b(tudo bem|tudo bom|tudo certo|como (ta|esta|vai|anda)|e ai|calor|quente|frio|chuva|chovendo|sol|tempo|familia|fim de semana|feriado|futebol|jogo|time)\b/;
const ASSUNTO_DO_NEGOCIO = /\b(preco|precos|valor|quanto|custa|estoque|tem|temos|prazo|entrega|entregam|frete|pagamento|boleto|pix|cartao|parcel\w*|desconto|medida|medidas|orcamento|produto|material|trabalham|vendem|fazem|aceita\w*|nota|nf|retirada|endereco|horario|abre|fecha)\b/;

/**
 * After the reader: a question left unregistered, open, or called unanswerable while a passage it saw
 * shares its key words gets one more look. Seen in the 16/10 runs (boleto 28 dias, prazo para Jaraguá).
 */
/** A size or thickness: "1,2mm", "3 m", "1200x3000", "50 x 50". */
const MEDIDA = /\d+(?:[.,]\d+)?\s*(?:mm|m)\b|\d\s*x\s*\d/;
const PECAS = /\b\d+\s*(barras?|pecas?|tubos?|chapas?|unidades?|varas?)\b/;
const PEDIDO_DE_ITEM = /\b(orcamento|cotacao|cotar|preciso|precisava|queria|quero|gostaria|vende|vendem|trabalha|trabalham)\b/;
const NEGA_LINHA = /\bn[aã]o (fornece|fornecemos|trabalhamos|temos|vendemos|fazemos|fabricamos|atendemos|entregamos|aceitamos|oferecemos)\b/;

const PEDE_CATALOGO = /\bcatalogo\b/;
const NAO_QUER_CATALOGO = /\b(nao|nem|sem|dispenso)\b.{0,30}\bcatalogo\b/;
/** A delivery place in the message ("Para entrega / Rua … Curitiba - PR", "entrega em Itajaí?"). */
const ENTREGA = /\b(entrega\w*|entregar|frete|cep|rua|avenida|bairro)\b|\s-\s?(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)\b/;

/** The reader gets one more look per turn, so every note found goes in it together. */
export function conferirLeitura(input: { ficha: FichaDoAtendimento; mensagem: string; pedido?: ContextoDoAtendimento }): string | null {
  const { ficha, mensagem, pedido } = input;
  const textoNormal = normalize(mensagem);
  const notas: string[] = [];
  // "Me manda o catálogo": the file goes with the reply, or the reply says "segue o catálogo" with nothing attached.
  if (pedido?.anexos?.length && PEDE_CATALOGO.test(textoNormal) && !NAO_QUER_CATALOGO.test(textoNormal) && !(ficha.anexosDaVez ?? []).length) {
    notas.push(`o contato fala do catálogo. Se ele pediu para ver ou receber, anexe com enviar_anexo (${pedido.anexos.map((item) => `${item.id}: ${item.titulo}`).join("; ")}). Se não pediu, não chame nada para isso.`);
  }
  // A city or address for delivery is a question even when written as information: does the company deliver there?
  const atuais = ficha.perguntas.filter((item) => item.status !== "tratada");
  if (ENTREGA.test(textoNormal.replace(/pronta entrega/g, " ")) && !atuais.some((item) => /entreg|frete|cidade|regiao|atend/.test(normalize(item.texto)))) {
    notas.push("a mensagem fala de entrega ou traz um endereço ou cidade. Registre \"vocês entregam em <cidade>?\" com registrar_pergunta e procure na base (região de entrega). Se não há cidade, não chame nada para isso.");
  }
  const perguntas = conferirPerguntas(input);
  if (perguntas) notas.push(perguntas);
  const lacuna = lacunasDaBase(ficha);
  if (lacuna) notas.push(lacuna);
  return notas.length ? notas.join(" Também: ") : null;
}

function conferirPerguntas({ ficha, mensagem, pedido }: { ficha: FichaDoAtendimento; mensagem: string; pedido?: ContextoDoAtendimento }): string | null {
  const atuais = ficha.perguntas.filter((item) => item.status !== "tratada");
  if (atuais.length === 0) {
    const texto = normalize(mensagem);
    // A request with sizes or "orçamento para…" has no question mark but is a question: "do you supply this?".
    const pedido = PEDIDO_DE_ITEM.test(texto) || /\d/.test(texto) && /[a-z]{4,}/.test(texto) && !PAPO_SOCIAL.test(texto);
    return (/\?/.test(mensagem) && ASSUNTO_DO_NEGOCIO.test(texto)) || pedido
      ? "a última mensagem parece pedir um produto ou perguntar sobre produto, preço, prazo, entrega ou pagamento, e nada foi registrado. Pedido de item sem interrogação também conta: registre com registrar_pergunta \"vocês fornecem <item>?\" e procure na base, inclusive o que a empresa não fornece. Se for só conversa, não chame nada."
      : null;
  }
  const abertas = atuais.filter((item) => item.status === "aberta");
  if (abertas.length) return `a pergunta ${abertas.map((item) => item.id).join(", ")} ficou sem desfecho: busque e responda com a base, ou marque sem base depois de buscar.`;
  for (const pergunta of atuais.filter((item) => item.status === "sem_base")) {
    const chaves = palavras(pergunta.texto);
    const parecidos = Object.entries(ficha.trechosVistos)
      .filter(([, texto]) => {
        const comuns = [...palavras(texto)].filter((word) => chaves.has(word)).length;
        // "Não trabalhamos com inox" answers "tem barra de inox?" with a single word in common.
        return comuns >= 2 || (comuns >= 1 && NEGA_LINHA.test(normalize(texto)));
      })
      .map(([id]) => id);
    if (parecidos.length) {
      return `você marcou ${pergunta.id} sem base, mas o trecho ${parecidos.join(", ")} fala do mesmo assunto. Releia: se ele responde (inclusive por faixa, lista ou regra geral), use responder_pergunta com as palavras exatas. Se não responde mesmo, não chame nada.`;
    }
  }
  // "10 barras de metalon": with a catalogue, the weight decides the minimum, and only the code may compute it.
  if (pedido?.catalogo && PECAS.test(normalize(mensagem)) && !(ficha.pesosDaVez ?? []).length) {
    return "o contato pediu uma quantidade em peças ou barras. Ache a medida com consultar_catalogo e calcule o peso com calcular_peso, para comparar com o pedido mínimo; responda com o peso calculado. Se faltar a medida ou o comprimento, não calcule: não chame nada.";
  }
  // "1,25m x 3m de 1,2mm? Tem dessa medida": the base said "sob encomenda", the catalogue has the 1,20 mm row,
  // and nobody looked. Seen in the test of 17/10, where the judge then blocked the answer as invented.
  const catalogo = pedido?.catalogo;
  const citouCatalogo = atuais.some((item) => [item.resposta, ...(item.maisRespostas ?? [])].some((resposta) => resposta && catalogo?.linha(resposta.trechoId)));
  if (catalogo && MEDIDA.test(normalize(mensagem)) && !citouCatalogo && !(ficha.pesosDaVez ?? []).length) {
    return "o contato cita uma medida ou espessura. Confira com consultar_catalogo se ela existe e, se existir, cite a linha com responder_pergunta na mesma pergunta. Se não achar, não chame nada.";
  }
  return null;
}
