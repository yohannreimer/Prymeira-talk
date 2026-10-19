import type { PriceHistoryRow, SupplierInput } from "@prymeira-talk/shared";
import { parseMoney } from "./format";

const norm = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function findColumn(headers: string[], patterns: RegExp[]) {
  const normalized = headers.map(norm);
  for (const pattern of patterns) {
    const index = normalized.findIndex((header) => pattern.test(header));
    if (index >= 0) return index;
  }
  return -1;
}

const cell = (row: string[], index: number) => index >= 0 ? (row[index] ?? "").trim() : "";

/** Supplier rows from a sheet whose first row is the header. Columns are found by name, in Portuguese. */
export function suppliersFromSheet(rows: string[][]): { rows: SupplierInput[]; missing: string[] } {
  const headers = rows[0] ?? [];
  const at = {
    name: findColumn(headers, [/^(fornecedor|empresa|razao social|nome fantasia|nome)$/, /fornecedor|empresa|razao|fantasia/, /nome/]),
    phone: findColumn(headers, [/whats/, /celular/, /telefone|fone|tel\b/]),
    contact: findColumn(headers, [/contato|vendedor|responsavel/]),
    email: findColumn(headers, [/e-?mail/]),
    cnpj: findColumn(headers, [/cnpj/]),
    city: findColumn(headers, [/cidade|municipio/]),
    categories: findColumn(headers, [/categoria|segmento|ramo|produto/]),
    notes: findColumn(headers, [/observ|nota/])
  };
  const missing = [at.name < 0 ? "nome do fornecedor" : null, at.phone < 0 ? "WhatsApp/telefone" : null].filter(Boolean) as string[];
  if (missing.length) return { rows: [], missing };
  const result: SupplierInput[] = [];
  for (const row of rows.slice(1)) {
    const name = cell(row, at.name);
    if (!name) continue;
    result.push({
      name, phone: cell(row, at.phone), contactName: cell(row, at.contact) || null, email: cell(row, at.email) || null,
      cnpj: cell(row, at.cnpj) || null, city: cell(row, at.city) || null, notes: cell(row, at.notes) || null,
      categories: cell(row, at.categories).split(/[,;/|]/).map((value) => value.trim()).filter(Boolean)
    });
  }
  return { rows: result, missing };
}

/** "10/03/2026", "2026-03-10", or an Excel serial day number → ISO date. */
export function parseSheetDate(value: string): string | null {
  const text = value.trim();
  let match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(text);
  if (match) {
    const year = match[3]!.length === 2 ? `20${match[3]}` : match[3]!;
    return `${year}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
  }
  match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(text)) * 86_400_000);
    return date.toISOString().slice(0, 10);
  }
  return null;
}

export function pricesFromSheet(rows: string[][]): { rows: PriceHistoryRow[]; missing: string[]; skipped: number } {
  const headers = rows[0] ?? [];
  const at = {
    item: findColumn(headers, [/^(item|produto|descricao|material)$/, /item|produto|descri|material/]),
    supplier: findColumn(headers, [/fornecedor|empresa/]),
    price: findColumn(headers, [/unitario|preco unit|valor unit/, /^(preco|valor)$/, /preco|valor/]),
    date: findColumn(headers, [/data|pago em|compra/]),
    unit: findColumn(headers, [/^(un|unid|unidade)$/, /unidade/]),
    quantity: findColumn(headers, [/^(qtd|qtde|quantidade)$/, /quant/])
  };
  const missing = [at.item < 0 ? "item" : null, at.price < 0 ? "preço unitário" : null, at.date < 0 ? "data" : null].filter(Boolean) as string[];
  if (missing.length) return { rows: [], missing, skipped: 0 };
  const result: PriceHistoryRow[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const itemName = cell(row, at.item);
    if (!itemName) continue;
    const unitPriceCents = parseMoney(cell(row, at.price));
    const paidAt = parseSheetDate(cell(row, at.date));
    if (unitPriceCents === null || !paidAt) { skipped += 1; continue; }
    const amount = Number(cell(row, at.quantity).replace(",", "."));
    result.push({ itemName, supplierName: cell(row, at.supplier) || null, unit: cell(row, at.unit) || null,
      quantity: Number.isFinite(amount) && amount > 0 ? amount : null, unitPriceCents, paidAt });
  }
  return { rows: result, missing, skipped };
}
