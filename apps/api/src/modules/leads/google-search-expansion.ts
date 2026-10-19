export interface GoogleSearchKeyword {
  id: string;
  keyword: string;
  term: string;
  city: string | null;
}

export const MAX_EXPANSION_NEARBY_CITIES = 5;
export const MAX_EXPANSION_SIMILAR_TERMS = 3;
export const GOOGLE_EXPANSION_ZOOM = 12;

// Termos que costumam aparecer juntos no Google Maps para o mesmo tipo de empresa.
const RELATED_NICHE_TERMS: Record<string, string[]> = {
  caldeiraria: ["metalúrgica", "estruturas metálicas", "usinagem", "serralheria industrial"],
  metalurgica: ["caldeiraria", "usinagem", "estruturas metálicas", "serralheria"],
  usinagem: ["tornearia", "ferramentaria", "metalúrgica", "caldeiraria"],
  tornearia: ["usinagem", "metalúrgica", "ferramentaria"],
  ferramentaria: ["usinagem", "moldes industriais", "tornearia"],
  serralheria: ["estruturas metálicas", "metalúrgica", "esquadrias de alumínio"],
  "estruturas metalicas": ["caldeiraria", "galpões metálicos", "serralheria", "metalúrgica"],
  solda: ["caldeiraria", "serralheria", "metalúrgica"],
  "pintura industrial": ["jateamento", "tratamento de superfície", "pintura eletrostática"],
  plastico: ["injeção plástica", "moldes industriais", "embalagens plásticas"],
  "injecao plastica": ["indústria de plásticos", "moldes industriais", "embalagens plásticas"],
  embalage: ["indústria de embalagens", "papelão ondulado", "embalagens plásticas"],
  confeccao: ["indústria têxtil", "malharia", "facção de costura"],
  textil: ["confecção", "malharia", "tecelagem"],
  malharia: ["confecção", "indústria têxtil", "facção de costura"],
  grafica: ["comunicação visual", "impressão digital", "gráfica rápida"],
  "comunicacao visual": ["gráfica", "letreiros", "fachadas"],
  marcenaria: ["móveis planejados", "móveis sob medida", "carpintaria"],
  "moveis planejados": ["marcenaria", "móveis sob medida", "loja de móveis"],
  construtora: ["engenharia civil", "incorporadora", "reformas"],
  "material de construcao": ["depósito de materiais de construção", "home center", "madeireira"],
  transportadora: ["logística", "transporte de cargas", "frete"],
  logistica: ["transportadora", "armazém", "transporte de cargas"],
  contabil: ["escritório de contabilidade", "contador", "assessoria contábil"],
  contabilidade: ["escritório contábil", "contador", "assessoria contábil"],
  advocacia: ["escritório de advocacia", "advogado"],
  advogado: ["escritório de advocacia", "advocacia"],
  odontolog: ["dentista", "consultório odontológico", "ortodontia"],
  dentista: ["clínica odontológica", "consultório odontológico", "ortodontia"],
  "clinica medica": ["consultório médico", "policlínica", "centro médico"],
  estetica: ["clínica de estética", "salão de beleza", "spa"],
  "salao de beleza": ["cabeleireiro", "estética", "manicure"],
  barbearia: ["cabeleireiro masculino", "salão de beleza"],
  academia: ["studio de pilates", "crossfit", "personal trainer"],
  padaria: ["panificadora", "confeitaria", "cafeteria"],
  confeitaria: ["padaria", "doceria", "bolos"],
  restaurante: ["lanchonete", "pizzaria", "churrascaria"],
  "pet shop": ["banho e tosa", "clínica veterinária", "agropecuária"],
  veterinari: ["pet shop", "hospital veterinário", "clínica veterinária"],
  "oficina mecanica": ["centro automotivo", "auto center", "funilaria"],
  autopeca: ["oficina mecânica", "distribuidora de autopeças", "centro automotivo"],
  imobiliaria: ["corretor de imóveis", "administradora de imóveis"],
  escola: ["colégio", "escola particular", "educação infantil"],
  supermercado: ["mercado", "atacadista", "mercearia"],
  farmacia: ["drogaria", "farmácia de manipulação"],
  otica: ["óculos", "optometrista"],
  hotel: ["pousada", "hostel"],
  "energia solar": ["energia fotovoltaica", "painéis solares"],
  "ar condicionado": ["climatização", "refrigeração"],
  refrigeracao: ["ar condicionado", "climatização", "câmaras frias"],
  eletric: ["instalações elétricas", "materiais elétricos", "eletricista"],
  hidraulic: ["encanador", "materiais hidráulicos"],
  distribuidora: ["atacadista", "representação comercial"],
  software: ["desenvolvimento de software", "empresa de tecnologia", "agência digital"],
  marketing: ["agência de marketing", "agência de publicidade", "marketing digital"]
};

export function normalizeSearchText(value: string) {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR").replace(/\s+/g, " ").trim();
}

function overlaps(first: string, second: string) {
  return first === second || first.includes(second) || second.includes(first);
}

// Termos parecidos: dicionário de nichos + categorias que o próprio Google deu aos resultados da busca original.
export function similarNicheTerms(niche: string, categories: Array<string | null | undefined> = []) {
  const normalizedNiche = normalizeSearchText(niche);
  const candidates: string[] = [];
  for (const [key, terms] of Object.entries(RELATED_NICHE_TERMS)) {
    if (normalizedNiche.includes(key)) candidates.push(...terms);
  }
  const counts = new Map<string, { label: string; count: number }>();
  for (const category of categories) {
    const label = category?.trim();
    if (!label || label.length > 80) continue;
    const key = normalizeSearchText(label);
    if (overlaps(key, normalizedNiche)) continue;
    const current = counts.get(key);
    counts.set(key, { label: current?.label ?? label, count: (current?.count ?? 0) + 1 });
  }
  const fromCategories = [...counts.values()]
    .sort((first, second) => second.count - first.count || first.label.localeCompare(second.label, "pt-BR"))
    .map((entry) => entry.label.toLocaleLowerCase("pt-BR"));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of [...fromCategories.slice(0, 2), ...candidates]) {
    const key = normalizeSearchText(term);
    if (!key || overlaps(key, normalizedNiche) || seen.has(key)) continue;
    seen.add(key);
    result.push(term);
    if (result.length >= MAX_EXPANSION_SIMILAR_TERMS) break;
  }
  return result;
}

export function primarySearchKeyword(input: { niche: string; city: string; state: string }): GoogleSearchKeyword {
  return { id: "p", keyword: `${input.niche} em ${input.city}, ${input.state}`, term: input.niche, city: input.city };
}

export function buildExpansionKeywords(input: {
  niche: string;
  city: string;
  state: string;
  nearbyCities: string[];
  similarTerms: string[];
}): GoogleSearchKeyword[] {
  const keywords: GoogleSearchKeyword[] = [{ id: "x-r", keyword: input.niche, term: input.niche, city: null }];
  const ownCity = normalizeSearchText(input.city);
  const cities = [...new Map(input.nearbyCities
    .map((city) => city.trim())
    .filter((city) => city && normalizeSearchText(city) !== ownCity)
    .map((city) => [normalizeSearchText(city), city] as const)).values()].slice(0, MAX_EXPANSION_NEARBY_CITIES);
  cities.forEach((city, index) => {
    keywords.push({ id: `x-c${index}`, keyword: `${input.niche} em ${city}, ${input.state}`, term: input.niche, city });
  });
  input.similarTerms.slice(0, MAX_EXPANSION_SIMILAR_TERMS).forEach((term, index) => {
    keywords.push({ id: `x-t${index}`, keyword: `${term} em ${input.city}, ${input.state}`, term, city: input.city });
  });
  return keywords;
}

export function remoteKeywordLine(keyword: GoogleSearchKeyword) {
  return `${keyword.keyword.replace(/#!#/g, " ")} #!#${keyword.id}`;
}
