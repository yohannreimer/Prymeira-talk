import type { FichaDoAtendimento } from "./tipos.js";

const normal = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const ignoradas = new Set("voces voce vcs vende vendem vender fornece fornecem temos tem preciso quero gostaria saber produto produtos material materiais qual quais uma para com como que dessa desse".split(" "));
const termos = (s: string) => new Set((normal(s).match(/[a-z]{3,}/g) ?? []).filter(t => !ignoradas.has(t)).map(t => t.replace(/s$/, "")));

/** Lexical hint only: never a final veto. Similar words do not prove a passage answers the same question. */
export function lacunasDaBase(ficha: FichaDoAtendimento): string | null {
  for (const p of ficha.perguntas.filter(p => p.status === "respondida" && p.resposta)) {
    const chaves = termos(p.texto);
    if (chaves.size < 2) continue;
    const score = (s: string) => [...termos(s)].filter(t => chaves.has(t)).length;
    const citadas = [p.resposta!, ...(p.maisRespostas ?? [])];
    const atual = Math.max(...citadas.map(c => score(c.citacao)));
    if (atual > 1) continue;
    const melhores = Object.entries(ficha.trechosVistos).filter(([id, texto]) => !citadas.some(c => c.trechoId === id) && score(texto) >= 2);
    if (melhores.length) return `a resposta de ${p.id} pode precisar de complemento; ${melhores.map(([id]) => id).join(", ")} tem palavras em comum, mas isso NÃO prova que responde ao mesmo item. Ignore correspondências de outro produto, cidade ou variante, regras de recusa e consulta já suficientes não precisam de confirmação positiva. Releia esses trechos: confira produto e material, cite o trecho específico e as condições relevantes com responder_pergunta. Use mais de uma citação quando forem complementares. Não misture produtos, não resolva contradições por suposição. Se não houver resposta segura, marque sem base.`;
  }
  return null;
}

/** Code catches greeting/menu-only replies even if the semantic reviewer is permissive. */
export function soSaudacaoOuOferta(texto: string): boolean {
  const partes = normal(texto).split(/[.!?\n]+/).map(s => s.trim()).filter(Boolean);
  return partes.length === 0 || partes.every(p =>
    /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem(?:,? e voce)?|tudo certo(?:,? e voce)?|e voce|como vai)[,\s]*$/.test(p) ||
    /^(?:voce )?(prefere|quer|gostaria|posso|deseja)\b/.test(p) && /\b(catalogo|vendedor|atendente)\b/.test(p));
}
