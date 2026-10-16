import { z } from "zod";
import type { HarnessMessage, HarnessTool } from "../../core/types.js";
import { renderFicha } from "./ficha.js";
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

const abrirArgs = z.object({ dono: z.enum(["cliente", "empresa"]), descricao: z.string().trim().min(5).max(200), ...provaArgs });
const abrirPendencia: Tool<z.infer<typeof abrirArgs>> = {
  name: "abrir_pendencia",
  description: "Registra algo que ficou em aberto e de quem é a vez. dono=cliente: o cliente ficou devendo (responder uma pergunta da empresa, enviar um dado, decidir sobre uma proposta ou catálogo que recebeu, voltar depois de 'vou ver'). dono=empresa: a empresa prometeu algo e ainda não cumpriu na conversa, ou o cliente perguntou e ficou sem resposta. A descrição é uma frase curta e concreta, com o item ou o assunto. Cite a mensagem que prova.",
  parameters: {
    type: "object",
    properties: { dono: { type: "string", enum: ["cliente", "empresa"] }, descricao: { type: "string" }, ...PROVA_PROPS },
    required: ["dono", "descricao", "mensagem", "trecho"],
    additionalProperties: false
  },
  schema: abrirArgs,
  execute(args, context) {
    if (!context.historico.some((message) => message.autor === "contato")) {
      throw new Error("o contato nunca respondeu nesta conversa: uma mensagem só da empresa não deixa pendência.");
    }
    const prova = conferirProva(context.historico, args.mensagem, args.trecho);
    const id = `p${context.ficha.pendencias.length + 1}`;
    const ficha = {
      ...context.ficha,
      pendencias: [...context.ficha.pendencias, { id, dono: args.dono, descricao: args.descricao, prova, status: "aberta" as const, resolvidaPor: null }]
    };
    context.setFicha(ficha);
    return ok(ficha);
  }
};

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
  description: "Retirada ou entrega combinada e acontecendo agora ('tô chegando', localização enviada, 'já saiu'). Não há o que cobrar do cliente nesse momento.",
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

/** The model sometimes writes "1" for "q1"; both mean the same registered question. */
const idDaPergunta = z.string().trim().min(1).transform((id) => (/^\d+$/.test(id) ? `q${id}` : id));

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
    if (!normalize(texto).includes(normalize(args.citacao))) throw new Error(`a citação não está no trecho ${args.trechoId}. Copie as palavras exatas.`);
    const ficha = {
      ...context.ficha,
      perguntas: context.ficha.perguntas.map((item) => item.id === args.perguntaId
        ? { ...item, status: "respondida" as const, resposta: { trechoId: args.trechoId, citacao: args.citacao } }
        : item)
    };
    context.setFicha(ficha);
    return ok(ficha);
  }
};

const semBaseArgs = z.object({ perguntaId: idDaPergunta });
const marcarSemBase: Tool<z.infer<typeof semBaseArgs>> = {
  name: "marcar_sem_base",
  description: "Marca que os documentos não respondem a pergunta. Só depois de buscar. Uma pessoa da empresa vai responder essa parte.",
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

export const ferramentasDeLeitura = [registrarPergunta, buscarNaBase, responderPergunta, marcarSemBase, pediuPessoa];

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
const NEGA_LINHA = /\bn[aã]o (trabalhamos|temos|vendemos|fazemos|fabricamos|atendemos|entregamos|aceitamos|oferecemos)\b/;

export function conferirLeitura({ ficha, mensagem }: { ficha: FichaDoAtendimento; mensagem: string }): string | null {
  const atuais = ficha.perguntas.filter((item) => item.status !== "tratada");
  if (atuais.length === 0) {
    const texto = normalize(mensagem);
    return /\?/.test(mensagem) && ASSUNTO_DO_NEGOCIO.test(texto)
      ? "a última mensagem parece ter pergunta sobre produto, preço, prazo, entrega ou pagamento, e nada foi registrado. Se for, registre com registrar_pergunta e procure na base. Se for só conversa, não chame nada."
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
  return null;
}
