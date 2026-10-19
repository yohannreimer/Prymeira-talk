import { strFromU8, unzipSync } from 'fflate';
import type { OwnBaseRow } from '@prymeira-talk/shared';

/**
 * Reads a spreadsheet in the browser: .xlsx (straight from its XML, so files the old reader choked on open) or .csv.
 * Every cell comes back as text; the person confirms what each column is before anything is sent.
 */
export type Sheet = { name: string; rows: string[][] };

/** XML text of a cell or shared string, entities decoded; rich text runs joined. */
function decode(text: string) {
  return text.replace(/&(#x?[0-9a-f]+|lt|gt|amp|quot|apos);/gi, (_, entity: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
    return String.fromCodePoint(entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
  });
}
const runs = (inner: string) => [...inner.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(match => decode(match[1]!)).join('');
/** "AB12" → 27 (zero-based column). */
function column(ref: string) {
  let index = 0;
  for (const char of ref.replace(/\d+/g, '')) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** Reads the workbook's XML as text (a DOM parser is far too slow for tens of thousands of rows). */
export function readXlsx(bytes: Uint8Array): Sheet[] {
  const files = unzipSync(bytes, { filter: file => file.name.startsWith('xl/') && (file.name.endsWith('.xml') || file.name.endsWith('.rels')) });
  const read = (name: string) => files[name] ? strFromU8(files[name]!) : null;
  const shared = read('xl/sharedStrings.xml');
  const strings = shared ? [...shared.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(match => runs(match[1]!)) : [];
  const targets = new Map<string, string>();
  for (const rel of (read('xl/_rels/workbook.xml.rels') ?? '').match(/<Relationship\b[^>]*>/g) ?? []) {
    const target = attr(rel, 'Target') ?? '';
    targets.set(attr(rel, 'Id') ?? '', target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new Error('Este arquivo não parece uma planilha do Excel.');
  return (workbook.match(/<(?:\w+:)?sheet\b[^>]*>/g) ?? []).map((tag, index) => {
    const path = targets.get(attr(tag, 'r:id') ?? '') ?? `xl/worksheets/sheet${index + 1}.xml`;
    const content = read(path) ?? '';
    const rows: string[][] = [];
    for (const row of content.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const cells: string[] = [];
      for (const cell of row[1]!.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const head = ` ${cell[1] ?? ''}`, inner = cell[2] ?? '';
        const ref = attr(head, 'r'), type = attr(head, 't');
        const at = ref ? column(ref) : cells.length;
        const value = decode(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1] ?? '');
        cells[at] = type === 's' ? strings[Number(value)] ?? '' : type === 'inlineStr' ? runs(inner) : type === 'b' ? (value === '1' ? 'Sim' : 'Não') : value;
      }
      rows.push(Array.from(cells, cell => (cell ?? '').trim()));
    }
    return { name: decode(attr(tag, 'name') ?? `Aba ${index + 1}`), rows };
  });
}

/** CSV with ; or , (whichever the header uses), quotes and line breaks inside quotes. */
export function readCsv(text: string): Sheet[] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const separator = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index]!;
    if (quoted) {
      if (char === '"' && clean[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === separator) { row.push(cell.trim()); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && clean[index + 1] === '\n') index++;
      row.push(cell.trim()); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return [{ name: 'Planilha', rows: rows.filter(values => values.some(Boolean)) }];
}

export async function readSpreadsheet(file: File): Promise<Sheet[]> {
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') return readCsv(await file.text());
  if (/\.xlsx$/i.test(file.name)) return readXlsx(new Uint8Array(await file.arrayBuffer()));
  throw new Error('Envie um arquivo .xlsx ou .csv. Planilhas .xls antigas: salve como .xlsx antes.');
}

// ---- Columns ----

export type Field = 'company' | 'phone' | 'contact' | 'email' | 'cnpj' | 'city' | 'state' | 'region' | 'activity' | 'originList' | 'notes' | 'ignore';
export const FIELD_LABELS: Record<Field, string> = {
  company: 'Empresa', phone: 'Telefone', contact: 'Contato', email: 'E-mail', cnpj: 'CNPJ', city: 'Cidade', state: 'UF',
  region: 'Região', activity: 'Atividade', originList: 'Lista de origem', notes: 'Observações', ignore: 'Não usar'
};
const fold = (value: string) => value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().trim();
const RULES: Array<[Field, RegExp]> = [
  ['ignore', /^(id|id empresa|registro|registros de origem|linha|arquivo|aba)$|e\.?164|json|sugerid|consulta|fonte|data da|revisar|situacao|alerta|criterio|codigo|formato|tipo d|valores originais|secundari/],
  ['cnpj', /cnpj|cpf|documento/],
  ['email', /e-?mail/],
  ['phone', /telefone|celular|whats|fone|contato telef|numero/],
  ['region', /regiao/],
  ['city', /municipio|cidade|localidade/],
  ['state', /^uf$|^estado$|uf no|^uf /],
  ['originList', /^listas? de origem$|^lista$|^origem$|lista de origem/],
  ['activity', /descricao (do )?cnae|atividade|segmento|categoria|ramo/],
  ['ignore', /cnae|nomes nas listas|locais nas listas|^sites?$|endereco/],
  ['notes', /observa|nota|coment/],
  ['contact', /contato|responsavel|comprador/],
  ['company', /empresa|razao social|nome fantasia|cliente|^nome$|nome da/]
];
/** What each header most likely is. A second company-like column (e.g. "Razão social" after "Nome da empresa") is not used. */
export function guessFields(headers: string[]): Field[] {
  const used = new Set<Field>();
  return headers.map(header => {
    const name = fold(header);
    const field = name ? RULES.find(([, rule]) => rule.test(name))?.[0] ?? 'ignore' : 'ignore';
    if (field === 'phone' || field === 'ignore') return field;
    if (used.has(field)) return 'ignore';
    used.add(field); return field;
  });
}

/** The sheet that looks like the list of companies: it needs a company and a phone column; then the one that says
 * the most about them (city, region, e-mail…), then the most rows. */
export function bestSheet(sheets: Sheet[]) {
  const score = (sheet: Sheet) => {
    const fields = new Set(guessFields(sheet.rows[0] ?? []).filter(field => field !== 'ignore'));
    return fields.has('company') && fields.has('phone') ? 100 + fields.size : fields.size;
  };
  return [...sheets].sort((a, b) => score(b) - score(a) || b.rows.length - a.rows.length)[0] ?? null;
}

/** The rows as Base própria companies; rows without a company name are left out. */
export function toRows(sheet: Sheet, fields: Field[]): OwnBaseRow[] {
  const value = (row: string[], field: Field) => fields.flatMap((f, index) => f === field && row[index] ? [row[index]!] : []);
  return sheet.rows.slice(1).flatMap(row => {
    const company = value(row, 'company')[0]?.slice(0, 200);
    if (!company) return [];
    const one = (field: Field, max: number) => { const text = value(row, field)[0]; return text ? { [field]: text.slice(0, max) } : {}; };
    return [{ company, phones: value(row, 'phone').slice(0, 10).map(phone => phone.slice(0, 400)).flatMap(phone => phone.split(/\s*[|;]\s*/)).filter(Boolean).slice(0, 10).map(phone => phone.slice(0, 40)),
      ...one('contact', 160), ...one('email', 200), ...one('cnpj', 30), ...one('city', 120), ...(value(row, 'state')[0] ? { state: value(row, 'state')[0]!.slice(0, 2) } : {}),
      ...one('region', 120), ...one('activity', 200), ...one('originList', 200), ...one('notes', 1000) } as OwnBaseRow];
  });
}
