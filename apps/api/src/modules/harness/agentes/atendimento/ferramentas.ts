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
