/**
 * Changes to Villefer's knowledge base that the company gave on 16/10/2026 (approximate minimums, the
 * cities it delivers to), tried in the simulator before anyone edits the base in production.
 * HARNESS_BASE_PROPOSTA=1 applies them on top of the exported sources (HARNESS_BASE_FONTES).
 */
type Fonte = { title: string; content: string | null };

export const PEDIDOS_MINIMOS = `PEDIDOS MÍNIMOS (informado pela empresa em 16/10/2026). Estes valores substituem os mínimos de textos anteriores.
Os mínimos são aproximados: o vendedor pode aceitar um pedido um pouco menor, quando o pedido é bom.
- Tubos (não inox) e perfis sob encomenda: aproximadamente 1.000 kg.
- Inox, inclusive tubos e perfis de inox: aproximadamente 300 kg. O vendedor costuma aceitar a partir de uns 250 kg.
- Alumínio: aproximadamente 300 kg. Sob encomenda, prazo de 5 a 10 dias úteis.
- Chapas: aproximadamente 350 kg.
- Vigas I, vigas U, perfil W e cantoneiras: sem mínimo informado.
Como falar do mínimo: diga o valor aproximado ("trabalhamos a partir de uns 1.000 kg de tubo") e pergunte a quantidade, se ainda não sabe. Não diga que o pedido é pequeno demais e não recuse o cliente. Se o pedido está perto do mínimo, ou o cliente quer seguir abaixo dele, passe ao vendedor, que decide; não prometa que será aceito. O peso de barras ou peças só vale calculado pelo sistema a partir do catálogo, nunca de cabeça.`;

export const REGIAO_DE_ENTREGA = `REGIÃO DE ENTREGA (informado pela empresa em 16/10/2026; lista parcial).
Entregamos em: Joinville, Araquari, Garuva, Jaraguá do Sul, Guaramirim, Schroeder, Corupá, Massaranduba, Itajaí, Blumenau, Indaial, Pomerode, Timbó e Balneário Camboriú.
Cliente de uma dessas cidades: confirme que entregamos lá e siga com o pedido. Prazo e frete o vendedor confirma.
Não atendemos estados distantes, como Bahia, São Paulo e Rio Grande do Sul: diga isso de forma cordial, sem chamar o vendedor.
Cidade que não está na lista: a lista não é completa, então não diga que atende nem que não atende. Diga que o vendedor confirma a entrega para a cidade e siga com o pedido.`;

/** Old sentences that state the previous minimums, and what replaces them. */
const TROCAS: Array<[string, string]> = [
  ["Inox, inclusive tubos e perfis de inox: mínimo de 300 kg. Tubos não inox e perfis sob encomenda: 1.000 kg.", "Mínimos aproximados: ver \"Pedidos mínimos\"."],
  [" Para alumínio e cantoneiras, mínimo não informado; tampouco inventar mínimo para barras ou chapas comuns.", " Cantoneiras e barras comuns: mínimo não informado; não inventar."],
  ["Cliente precisa de 50 kg de inox: explicar 300 kg e perguntar uma vez se atende.", "Cliente precisa de 50 kg de inox: explicar que o mínimo é de uns 300 kg e perguntar uma vez se atende."],
  ["Mínimos: inox inclusive tubos/perfis 300 kg; tubos não inox e perfis sob encomenda 1.000 kg. Alumínio e cantoneiras sem mínimo confirmado.", "Mínimos: ver \"Pedidos mínimos\"."]
];

/** The sources with the old minimums rewritten and the two new texts added. Returns the sentences it could not find. */
export function aplicarPropostaVillefer<T extends Fonte>(fontes: T[]): { fontes: Fonte[]; naoEncontradas: string[] } {
  const naoEncontradas = TROCAS.filter(([velho]) => !fontes.some((fonte) => fonte.content?.includes(velho))).map(([velho]) => velho);
  const trocadas = fontes.map((fonte) => ({ ...fonte, content: TROCAS.reduce((texto, [velho, novo]) => texto?.replace(velho, novo) ?? null, fonte.content) }));
  return { fontes: [...trocadas, { title: "Pedidos mínimos", content: PEDIDOS_MINIMOS }, { title: "Região de entrega", content: REGIAO_DE_ENTREGA }], naoEncontradas };
}
