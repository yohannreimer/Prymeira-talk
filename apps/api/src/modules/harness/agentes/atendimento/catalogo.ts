import { z } from "zod";
import type { HarnessTool } from "../../core/types.js";
import type { ContextoDoAtendimento, FichaDoAtendimento } from "./tipos.js";

/**
 * The company's product tables (sizes and theoretical weights), consulted by a tool instead of read as
 * text: the tables are too long for the base, and a weight is computed here, never by the model.
 * What the company supplies is still decided by the approved base; the catalogue only says which sizes
 * exist and how much they weigh.
 */
export type LinhaDoCatalogo = {
  id: string;
  familia: string;
  material: string[];
  /** One line a salesperson would search, with every alias of the table ("2\" (50,8 mm) · quadrado 40x40"). */
  descricao: string;
  kgPorMetro: number | null;
  kgPorMetroQuadrado: number | null;
  nota?: string | null;
};

export type Catalogo = {
  buscar(consulta: string): LinhaDoCatalogo[];
  linha(id: string): LinhaDoCatalogo | undefined;
};

type Tool<Args> = HarnessTool<FichaDoAtendimento, ContextoDoAtendimento, Args>;

const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Words customers use for a family that the tables name differently. */
const SINONIMOS: Record<string, string[]> = {
  metalon: ["tubo", "industrial", "quadrado", "retangular"],
  tarugo: ["barra", "redonda"],
  ferro: ["aco", "carbono"],
  inox: ["inoxidavel"],
  chato: ["chata"],
  redondo: ["redonda"],
  sch: ["schedule"]
};

/** Numbers and sizes as comparable tokens: "1,50" and "1.5" are the same, "40x40" also counts as 40. */
function tokens(text: string): { palavras: Set<string>; numeros: Set<string> } {
  const texto = normalize(text);
  const palavras = new Set<string>();
  for (const palavra of texto.match(/[a-z]{3,}/g) ?? []) {
    palavras.add(palavra);
    for (const sinonimo of SINONIMOS[palavra] ?? []) palavras.add(sinonimo);
  }
  const numeros = new Set<string>();
  // Inches as written in the tables (2", 1.1/2") or by customers ("2 polegadas"); kept apart from mm.
  const POLEGADA = /\d+(?:\.\d+\/\d+|\/\d+)?\s*(?:"|”|polegadas?|pol\b)/g;
  for (const polegada of texto.match(POLEGADA) ?? []) numeros.add(`${polegada.match(/[\d./]+/)![0]}"`);
  const semPolegadas = texto.replace(POLEGADA, " ");
  for (const medida of semPolegadas.match(/\d+(?:[.,]\d+)?(?:\s*x\s*\d+(?:[.,]\d+)?)+/g) ?? []) numeros.add(medida.replace(/\s/g, "").replace(/,/g, "."));
  for (const numero of semPolegadas.match(/\d+(?:[.,]\d+)?/g) ?? []) numeros.add(String(Number(numero.replace(",", "."))));
  return { palavras, numeros };
}

/** In-memory search: sizes weigh more than words, since every row of a family shares its words. */
export function catalogoEmMemoria(linhas: LinhaDoCatalogo[], limite = 8): Catalogo {
  const indice = linhas.map((linha) => ({ linha, ...tokens(`${linha.familia} ${linha.material.join(" ")} ${linha.descricao}`) }));
  const porId = new Map(linhas.map((linha) => [linha.id, linha]));
  return {
    buscar(consulta) {
      const busca = tokens(consulta);
      return indice
        .map((item) => {
          const numeros = [...busca.numeros].filter((numero) => item.numeros.has(numero)).length;
          const palavras = [...busca.palavras].filter((palavra) => item.palavras.has(palavra)).length;
          return { linha: item.linha, numeros, score: numeros * 3 + palavras };
        })
        .filter((item) => item.score > 0 && (item.numeros > 0 || busca.numeros.size === 0))
        .sort((a, b) => b.score - a.score)
        .slice(0, limite)
        .map((item) => item.linha);
    },
    linha: (id) => porId.get(id)
  };
}

const kg = (valor: number) => valor.toLocaleString("pt-BR", { maximumFractionDigits: valor < 10 ? 2 : 1 });

export const textoDaLinha = (linha: LinhaDoCatalogo) => [
  `${linha.familia}: ${linha.descricao}`,
  `material: ${linha.material.join(" ou ")}`,
  linha.kgPorMetro !== null ? `${kg(linha.kgPorMetro)} kg/m` : null,
  linha.kgPorMetroQuadrado !== null ? `${kg(linha.kgPorMetroQuadrado)} kg/m²` : null,
  linha.nota ? `obs.: ${linha.nota}` : null
].filter(Boolean).join(" · ");

const consultaArgs = z.object({ consulta: z.string().trim().min(2).max(200) });
const consultarCatalogo: Tool<z.infer<typeof consultaArgs>> = {
  name: "consultar_catalogo",
  description: "Procura no catálogo de produtos as medidas que existem e o peso teórico (kg/m ou kg/m²). Use para saber se uma medida existe ou para calcular o peso de um pedido. Não diz se a empresa fornece o produto hoje: isso é a base.",
  parameters: {
    type: "object",
    properties: { consulta: { type: "string", description: "Produto e medidas, como o cliente escreveu (\"metalon 40x40 parede 1,5\", \"barra redonda 2 polegadas\")." } },
    required: ["consulta"],
    additionalProperties: false
  },
  schema: consultaArgs,
  execute(args, context) {
    const catalogo = context.pedido.catalogo;
    if (!catalogo) return "Esta empresa não tem catálogo de medidas cadastrado. Use a base.";
    const linhas = catalogo.buscar(args.consulta);
    if (!linhas.length) return "Nenhuma linha do catálogo com essas medidas. Tente com a medida escrita de outro jeito (mm ou polegadas), ou siga sem o catálogo.";
    context.setFicha({ ...context.ficha, trechosVistos: { ...context.ficha.trechosVistos, ...Object.fromEntries(linhas.map((linha) => [linha.id, textoDaLinha(linha)])) } });
    return `Catálogo (medidas e pesos; o que a empresa fornece hoje é o que diz a base):\n${linhas.map((linha) => `[${linha.id}] ${textoDaLinha(linha)}`).join("\n")}`;
  }
};

const pesoArgs = z.object({
  linhaId: z.string().min(1),
  pecas: z.number().positive(),
  comprimentoM: z.number().positive(),
  larguraM: z.number().positive().nullish()
});
const calcularPeso: Tool<z.infer<typeof pesoArgs>> = {
  name: "calcular_peso",
  description: "Calcula o peso teórico de um pedido a partir de uma linha do catálogo, para comparar com o pedido mínimo. A conta é feita pelo sistema: nunca calcule peso de cabeça. Barras, tubos e perfis: peças e comprimento de cada peça. Chapas: peças, comprimento e largura.",
  parameters: {
    type: "object",
    properties: {
      linhaId: { type: "string", description: "Id da linha, de consultar_catalogo." },
      pecas: { type: "number", description: "Quantidade de peças, barras ou chapas." },
      comprimentoM: { type: "number", description: "Comprimento de cada peça em metros. Barras e tubos têm 6 m só se o cliente disse." },
      larguraM: { type: ["number", "null"], description: "Largura em metros, só para chapas." }
    },
    required: ["linhaId", "pecas", "comprimentoM", "larguraM"],
    additionalProperties: false
  },
  schema: pesoArgs,
  execute(args, context) {
    const linha = context.pedido.catalogo?.linha(args.linhaId);
    if (!linha) throw new Error(`a linha ${args.linhaId} não existe; use consultar_catalogo antes.`);
    let total: number;
    let conta: string;
    if (linha.kgPorMetro !== null) {
      total = args.pecas * args.comprimentoM * linha.kgPorMetro;
      conta = `${args.pecas} × ${args.comprimentoM} m × ${kg(linha.kgPorMetro)} kg/m`;
    } else if (linha.kgPorMetroQuadrado !== null) {
      if (!args.larguraM) throw new Error("essa linha é chapa (kg/m²): informe larguraM.");
      total = args.pecas * args.comprimentoM * args.larguraM * linha.kgPorMetroQuadrado;
      conta = `${args.pecas} × ${args.comprimentoM} m × ${args.larguraM} m × ${kg(linha.kgPorMetroQuadrado)} kg/m²`;
    } else {
      throw new Error(`a linha ${args.linhaId} não tem peso no catálogo.`);
    }
    const id = `peso${Object.keys(context.ficha.trechosVistos).filter((chave) => chave.startsWith("peso")).length + 1}`;
    const texto = `Peso teórico de ${linha.descricao}: ${conta} = aproximadamente ${kg(total)} kg (catálogo, linha ${linha.id}).`;
    context.setFicha({ ...context.ficha, trechosVistos: { ...context.ficha.trechosVistos, [id]: texto } });
    return `[${id}] ${texto}\nPara usar na resposta, responder_pergunta com trechoId ${id}.`;
  }
};

export const ferramentasDoCatalogo = [consultarCatalogo, calcularPeso];
