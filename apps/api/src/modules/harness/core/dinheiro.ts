/** "R$ 1.234,56" for prices, without cents when the value is whole ("R$ 845"). */
export function formatBRL(value: number) {
  const whole = Math.abs(value - Math.round(value)) < 0.005;
  return `R$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** Brazilian number text to a number: "1.234,56" → 1234.56, "845" → 845, "1234.5" → 1234.5. */
export function parseBRNumber(text: string): number | null {
  const clean = text.trim();
  if (!/\d/.test(clean)) return null;
  let normalized: string;
  if (clean.includes(",")) normalized = clean.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(clean)) normalized = clean.replace(/\./g, "");
  else normalized = clean;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** Every money amount written in a message: "R$ 845", "R$1.234,50", "845 reais", "2 mil reais". */
export function findMoneyAmounts(text: string): number[] {
  const amounts: number[] = [];
  for (const match of text.matchAll(/R\$\s*(\d[\d.,]*\d|\d)(\s*mil\b)?/gi)) {
    const value = parseBRNumber(match[1]);
    if (value !== null) amounts.push(match[2] ? value * 1000 : value);
  }
  for (const match of text.matchAll(/(?<!R\$\s*)(?<![\d.,])(\d[\d.,]*\d|\d)\s*(mil\s+)?reais\b/gi)) {
    const value = parseBRNumber(match[1]);
    if (value !== null) amounts.push(match[2] ? value * 1000 : value);
  }
  return amounts;
}

export function findPercentages(text: string): number[] {
  return [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].flatMap((match) => {
    const value = parseBRNumber(match[1]);
    return value === null ? [] : [value];
  });
}

export function sameAmount(a: number, b: number) {
  return Math.abs(a - b) < 0.01;
}
