import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { bestSheet, guessFields, readCsv, readXlsx, toRows } from './spreadsheet';

function workbook(sheets: Record<string, string[][]>) {
  const names = Object.keys(sheets), shared: string[] = [];
  const index = (value: string) => { const at = shared.indexOf(value); return at >= 0 ? at : shared.push(value) - 1; };
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`)
  };
  names.forEach((name, i) => {
    const rows = sheets[name]!.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => value === '' ? '' : /^\d+$/.test(value)
      ? `<c r="${String.fromCharCode(65 + c)}${r + 1}"><v>${value}</v></c>` : `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="s"><v>${index(value)}</v></c>`).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  });
  files['xl/sharedStrings.xml'] = strToU8(`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map(value => `<si><t>${value.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`);
  return zipSync(files);
}

describe('spreadsheet import', () => {
  it('reads an .xlsx, picks the companies sheet and maps its columns', () => {
    const sheets = readXlsx(workbook({
      Resumo: [['Medida', 'Quantidade'], ['Listas', '5']],
      Cadastros: [['ID empresa', 'Nome da empresa', 'Município', 'Região', 'Telefone principal', 'Todos os telefones', 'E-mails', 'Descrição CNAE', 'Listas de origem'],
        ['EMP-1', 'Ferraço & Filhos', 'JOINVILLE', 'Joinville / Araquari', '+5547999015903', '+5547999015903 | 4734361111', 'compras@ferraco.com', 'Serralheria', 'Clientes Joinville'],
        ['EMP-2', '', 'Araquari', '', '', '', '', '', ''],
        ['EMP-3', 'Abrastech', 'Araquari', 'Joinville / Araquari', '34329952', '', '', '', '']]
    }));
    const sheet = bestSheet(sheets)!;
    expect(sheet.name).toBe('Cadastros');
    const fields = guessFields(sheet.rows[0]!);
    expect(fields).toEqual(['ignore', 'company', 'city', 'region', 'phone', 'phone', 'email', 'activity', 'originList']);
    expect(toRows(sheet, fields)).toEqual([
      { company: 'Ferraço & Filhos', phones: ['+5547999015903', '+5547999015903', '4734361111'], city: 'JOINVILLE', region: 'Joinville / Araquari', email: 'compras@ferraco.com', activity: 'Serralheria', originList: 'Clientes Joinville' },
      { company: 'Abrastech', phones: ['34329952'], city: 'Araquari', region: 'Joinville / Araquari' }
    ]);
  });
  it('reads a CSV with ; and quoted values', () => {
    const [sheet] = readCsv('﻿Empresa;Telefone 1;Telefone 2;Cidade\n"Vogel; Advocacia";(47) 3275-2044;;Jaraguá do Sul\r\nTecjat;4721010250;47999990000;Joinville\n');
    expect(sheet!.rows).toEqual([['Empresa', 'Telefone 1', 'Telefone 2', 'Cidade'], ['Vogel; Advocacia', '(47) 3275-2044', '', 'Jaraguá do Sul'], ['Tecjat', '4721010250', '47999990000', 'Joinville']]);
    expect(guessFields(sheet!.rows[0]!)).toEqual(['company', 'phone', 'phone', 'city']);
  });
});
