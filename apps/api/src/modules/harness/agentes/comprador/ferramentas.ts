import { z } from "zod";
import type { HarnessTool } from "../../core/types.js";
import { propostaAtual, renderFicha } from "./ficha.js";
import type { FichaDoFornecedor, PedidoDeCompra, VersaoDaProposta } from "./tipos.js";

type Tool<Args> = HarnessTool<FichaDoFornecedor, PedidoDeCompra, Args>;

const propostaArgs = z.object({
  itens: z.array(z.object({ itemId: z.string(), precoUnitario: z.number().positive() })).optional(),
  frete: z.number().min(0).nullable().optional(),
  prazoEntrega: z.string().min(1).nullable().optional(),
  pagamento: z.string().min(1).nullable().optional(),
  validade: z.string().min(1).nullable().optional(),
  observacao: z.string().min(1).nullable().optional()
});

/** Each call creates a new version from the previous one, so the history of the quote stays visible. */
const registrarProposta: Tool<z.infer<typeof propostaArgs>> = {
  name: "registrar_proposta",
  description:
    "Registra o que o fornecedor informou sobre a proposta: preço unitário por item (use o id do item do pedido), frete (0 se grátis), prazo de entrega, pagamento, validade, observação. Envie só os campos que a mensagem informa; os outros continuam como estavam. Um preço novo substitui o anterior.",
  parameters: {
    type: "object",
    properties: {
      itens: {
        type: "array",
        items: {
          type: "object",
          properties: { itemId: { type: "string" }, precoUnitario: { type: "number", description: "Preço por unidade, em reais." } },
          required: ["itemId", "precoUnitario"],
          additionalProperties: false
        }
      },
      frete: { type: ["number", "null"], description: "Valor do frete em reais; 0 quando grátis ou incluso." },
      prazoEntrega: { type: ["string", "null"], description: "Como o fornecedor disse, ex.: '10 dias úteis' ou 'até 05/11'." },
      pagamento: { type: ["string", "null"], description: "Ex.: '28/56 dias', 'PIX à vista', 'boleto 30 dias'." },
      validade: { type: ["string", "null"], description: "Até quando vale a proposta." },
      observacao: { type: ["string", "null"], description: "Condição importante que não cabe nos outros campos." }
    },
    additionalProperties: false
  },
  schema: propostaArgs,
  execute(args, context) {
    const known = new Set(context.pedido.itens.map((item) => item.id));
    const unknown = (args.itens ?? []).filter((line) => !known.has(line.itemId)).map((line) => line.itemId);
    if (unknown.length) throw new Error(`itemId inexistente: ${unknown.join(", ")}. Ids válidos: ${[...known].join(", ")}.`);
    const before = propostaAtual(context.ficha);
    const itens = new Map((before?.itens ?? []).map((line) => [line.itemId, line.precoUnitario]));
    for (const line of args.itens ?? []) itens.set(line.itemId, line.precoUnitario);
    const next: VersaoDaProposta = {
      itens: [...itens].map(([itemId, precoUnitario]) => ({ itemId, precoUnitario })),
      frete: args.frete ?? before?.frete ?? null,
      prazoEntrega: args.prazoEntrega ?? before?.prazoEntrega ?? null,
      pagamento: args.pagamento ?? before?.pagamento ?? null,
      validade: args.validade ?? before?.validade ?? null,
      observacao: args.observacao ?? before?.observacao ?? null,
      origem: context.mensagemAtual.slice(0, 500)
    };
    const ficha = { ...context.ficha, propostas: [...context.ficha.propostas, next], fornecedorVaiVerificar: false };
    context.setFicha(ficha);
    return `Registrado. Ficha agora:\n${renderFicha(ficha, context.pedido)}`;
  }
};

const contatoArgs = z.object({ nome: z.string().min(1) });
const registrarContato: Tool<z.infer<typeof contatoArgs>> = {
  name: "registrar_contato",
  description: "Registra o nome da pessoa que está falando pelo fornecedor, quando ela se apresenta.",
  parameters: { type: "object", properties: { nome: { type: "string" } }, required: ["nome"], additionalProperties: false },
  schema: contatoArgs,
  execute(args, context) {
    context.setFicha({ ...context.ficha, contato: { ...context.ficha.contato, nome: args.nome } });
    return "Registrado.";
  }
};

const perguntaArgs = z.object({
  tipo: z.enum(["valor_concorrente", "nome_concorrente", "sobre_pedido", "outra"]),
  pergunta: z.string().min(1)
});
const registrarPergunta: Tool<z.infer<typeof perguntaArgs>> = {
  name: "registrar_pergunta",
  description:
    "Registra uma pergunta que o fornecedor fez para nós. tipo valor_concorrente: perguntou EXPLICITAMENTE quanto é a outra proposta, qual valor temos, quanto precisa chegar. nome_concorrente: perguntou de quem é a outra proposta. sobre_pedido: dúvida sobre itens, medidas, entrega, nota. outra: qualquer outra.",
  parameters: {
    type: "object",
    properties: {
      tipo: { type: "string", enum: ["valor_concorrente", "nome_concorrente", "sobre_pedido", "outra"] },
      pergunta: { type: "string" }
    },
    required: ["tipo", "pergunta"],
    additionalProperties: false
  },
  schema: perguntaArgs,
  execute(args, context) {
    const ficha = context.ficha;
    if (args.tipo === "valor_concorrente") context.setFicha({ ...ficha, perguntouValorConcorrente: true });
    else if (args.tipo === "nome_concorrente") context.setFicha({ ...ficha, perguntouNomeConcorrente: true });
    else context.setFicha({ ...ficha, perguntasPendentes: [...ficha.perguntasPendentes, args.pergunta] });
    return "Registrado.";
  }
};

const vazio = z.object({}).passthrough();
const registrarSemDesconto: Tool<z.infer<typeof vazio>> = {
  name: "registrar_sem_desconto",
  description: "O fornecedor disse que não consegue melhorar o preço.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  schema: vazio,
  execute(_args, context) {
    context.setFicha({ ...context.ficha, semDesconto: true });
    return "Registrado.";
  }
};

const registrarVaiVerificar: Tool<z.infer<typeof vazio>> = {
  name: "registrar_vai_verificar",
  description: "O fornecedor disse que vai verificar, consultar alguém ou mandar depois, sem dar a informação agora.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  schema: vazio,
  execute(_args, context) {
    context.setFicha({ ...context.ficha, fornecedorVaiVerificar: true });
    return "Registrado.";
  }
};

const observacaoArgs = z.object({ texto: z.string().min(1) });
const registrarObservacao: Tool<z.infer<typeof observacaoArgs>> = {
  name: "registrar_observacao",
  description: "Registra um fato útil que não é preço nem condição: ex. 'só tem na cor preta', 'pedido mínimo de 10 unidades'.",
  parameters: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"], additionalProperties: false },
  schema: observacaoArgs,
  execute(args, context) {
    context.setFicha({ ...context.ficha, observacoes: [...context.ficha.observacoes, args.texto] });
    return "Registrado.";
  }
};

const declinouArgs = z.object({ motivo: z.string().min(1) });
const marcarDeclinou: Tool<z.infer<typeof declinouArgs>> = {
  name: "marcar_declinou",
  description: "O fornecedor não vai cotar: não trabalha com o item, não atende a região, não quer participar.",
  parameters: { type: "object", properties: { motivo: { type: "string" } }, required: ["motivo"], additionalProperties: false },
  schema: declinouArgs,
  execute(args, context) {
    context.setFicha({ ...context.ficha, etapa: "declinou", motivoRecusa: args.motivo });
    return "Registrado.";
  }
};

export const ferramentasDeLeitura = [
  registrarProposta,
  registrarContato,
  registrarPergunta,
  registrarSemDesconto,
  registrarVaiVerificar,
  registrarObservacao,
  marcarDeclinou
];
