import { z } from "zod";
import type { HarnessTool } from "../../core/types.js";
import { renderFicha } from "./ficha.js";
import type { CampanhaDeProspeccao, FichaDoLead } from "./tipos.js";

type Tool<Args> = HarnessTool<FichaDoLead, CampanhaDeProspeccao, Args>;
const ok = (ficha: FichaDoLead) => `Registrado. Ficha agora:\n${renderFicha(ficha)}`;

function tool<Args>(spec: Omit<Tool<Args>, "execute"> & { apply: (args: Args, ficha: FichaDoLead) => FichaDoLead }): Tool<Args> {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    schema: spec.schema,
    execute(args, context) {
      const ficha = spec.apply(args, context.ficha);
      context.setFicha(ficha);
      return ok(ficha);
    }
  };
}

const contatoArgs = z.object({ nome: z.string().trim().min(2).nullable().optional(), papel: z.enum(["decisor", "nao_decisor", "desconhecido"]) });
const registrarContato = tool<z.infer<typeof contatoArgs>>({
  name: "registrar_contato",
  description: "Quem está respondendo. decisor: dono, sócio, gerente ou quem cuida do assunto. nao_decisor: recepção, atendente, outro setor, 'não é comigo'. Registre o nome só se a pessoa se apresentou (nunca use o nome da empresa).",
  parameters: { type: "object", properties: { nome: { type: ["string", "null"] }, papel: { type: "string", enum: ["decisor", "nao_decisor", "desconhecido"] } }, required: ["papel"], additionalProperties: false },
  schema: contatoArgs,
  apply: (args, ficha) => ({ ...ficha, contato: { ...ficha.contato, nome: args.nome ?? ficha.contato.nome, papel: args.papel } })
});

const textoArgs = z.object({ texto: z.string().trim().min(3).max(300) });
const registrarDor = tool<z.infer<typeof textoArgs>>({
  name: "registrar_dor",
  description: "Algo concreto que o lead contou da rotina, do problema ou do volume dele (ex.: '3 pessoas atendendo loja e WhatsApp ao mesmo tempo').",
  parameters: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"], additionalProperties: false },
  schema: textoArgs,
  apply: (args, ficha) => ({ ...ficha, dor: args.texto })
});

const registrarPergunta = tool<z.infer<typeof textoArgs>>({
  name: "registrar_pergunta_do_lead",
  description: "Uma pergunta do lead que precisa de resposta (quem somos, do que se trata, preço, como funciona...). Uma chamada por pergunta.",
  parameters: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"], additionalProperties: false },
  schema: textoArgs,
  apply: (args, ficha) => ({ ...ficha, perguntasDoLead: [...ficha.perguntasDoLead, args.texto] })
});

const registrarObjecao = tool<z.infer<typeof textoArgs>>({
  name: "registrar_objecao",
  description: "Uma objeção que NÃO é recusa: 'já temos sistema', 'está caro', 'agora estamos sem tempo', 'manda por escrito'. Se o lead disse claramente que não quer, use registrar_interesse com sem_interesse.",
  parameters: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"], additionalProperties: false },
  schema: textoArgs,
  apply: (args, ficha) => ({ ...ficha, objecao: { texto: args.texto, tratada: false } })
});

const interesseArgs = z.object({ nivel: z.enum(["curioso", "interessado", "sem_interesse"]) });
const registrarInteresse = tool<z.infer<typeof interesseArgs>>({
  name: "registrar_interesse",
  description: "curioso: quer entender. interessado: quer seguir, pediu detalhes para decidir. sem_interesse: recusou, mesmo que com educação ('no momento não', 'já estamos bem', 'não precisamos, obrigada').",
  parameters: { type: "object", properties: { nivel: { type: "string", enum: ["curioso", "interessado", "sem_interesse"] } }, required: ["nivel"], additionalProperties: false },
  schema: interesseArgs,
  apply: (args, ficha) => ({ ...ficha, interesse: args.nivel })
});

const indicadoArgs = z.object({ nome: z.string().trim().min(2), contato: z.string().trim().min(8).nullable().optional() });
const registrarIndicado = tool<z.infer<typeof indicadoArgs>>({
  name: "registrar_indicado",
  description: "O lead indicou outra pessoa para tratar do assunto, com o contato se ele passou.",
  parameters: { type: "object", properties: { nome: { type: "string" }, contato: { type: ["string", "null"] } }, required: ["nome"], additionalProperties: false },
  schema: indicadoArgs,
  apply: (args, ficha) => ({ ...ficha, indicado: { nome: args.nome, contato: args.contato ?? ficha.indicado?.contato ?? null } })
});

const aceiteArgs = z.object({ detalhe: z.string().trim().min(2).max(200) });
const registrarAceite = tool<z.infer<typeof aceiteArgs>>({
  name: "registrar_aceite",
  description: "O lead aceitou o objetivo (topou a call, escolheu um horário, pediu para ligarem). Detalhe: o que ele aceitou, com dia ou horário se disse.",
  parameters: { type: "object", properties: { detalhe: { type: "string" } }, required: ["detalhe"], additionalProperties: false },
  schema: aceiteArgs,
  apply: (args, ficha) => ({ ...ficha, aceite: args.detalhe })
});

export const ferramentasDeLeitura = [registrarContato, registrarDor, registrarPergunta, registrarObjecao, registrarInteresse, registrarIndicado, registrarAceite];
