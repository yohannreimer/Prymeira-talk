import { useMemo, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { MAX_OWN_BASE_IMPORT_ROWS } from "@prymeira-talk/shared";
import { useTalkAuth } from "../../app/auth";
import { apiOwnBaseImport } from "../../app/api";
import { bestSheet, FIELD_LABELS, guessFields, readSpreadsheet, toRows, type Field, type Sheet } from "./spreadsheet";

const FIELDS = Object.keys(FIELD_LABELS) as Field[];
export const TEMPLATE_HEADER = ["Empresa", "Telefone 1", "Telefone 2", "Telefone 3", "Contato", "E-mail", "CNPJ", "Cidade", "UF", "Região", "Observações"];
export const AI_PROMPT = `Reescreva a planilha que vou enviar numa nova planilha .xlsx com UMA linha por empresa e estas colunas, nesta ordem:
${TEMPLATE_HEADER.join(" | ")}

- Telefones no formato +55DDDNÚMERO (ex.: +5547988372290), um por coluna; crie Telefone 4, 5… se precisar.
- Sem DDD, não invente: deixe o número em Observações.
- Junte linhas repetidas da mesma empresa (mesmo CNPJ ou mesmo nome e telefone).
- Cidade sem abreviação e com acentos; UF com 2 letras.
- Região pela cidade, conforme esta lista: [cole aqui suas regiões e as cidades de cada uma].
- Não invente dados; o que não souber, deixe vazio.`;

function downloadTemplate() {
  const blob = new Blob([`﻿${TEMPLATE_HEADER.join(";")}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = "modelo-base-propria.csv"; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** A phone the server will accept for WhatsApp: 10 or 11 digits after an optional 55. */
const usablePhone = (value: string) => /^(55)?\d{10,11}$/.test(value.replace(/\D/g, ""));

/** Upload a spreadsheet: pick the file, confirm the columns, see what will be saved, then send it in parts. */
export function OwnBaseImport({ listId, onCancel, onDone }: { listId: string | null; onCancel: () => void; onDone: (message: string) => void }) {
  const { getToken } = useTalkAuth();
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetName, setSheetName] = useState("");
  const [fields, setFields] = useState<Field[]>([]);
  const [name, setName] = useState("");
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sheet = sheets.find(item => item.name === sheetName) ?? null;
  const rows = useMemo(() => sheet ? toRows(sheet, fields) : [], [sheet, fields]);
  const summary = useMemo(() => ({
    companies: rows.length,
    withPhone: rows.filter(row => row.phones.some(phone => phone.split(/[|;,/]+/).some(usablePhone))).length,
    regions: new Set(rows.map(row => row.region).filter(Boolean)).size
  }), [rows]);

  async function pick(next: File | undefined) {
    if (!next) return;
    setError(null); setReading(true);
    try {
      const read = (await readSpreadsheet(next)).filter(item => item.rows.length > 1);
      if (!read.length) throw new Error("A planilha está vazia.");
      const chosen = bestSheet(read)!;
      setFile(next); setSheets(read); setSheetName(chosen.name); setFields(guessFields(chosen.rows[0] ?? []));
      setName(current => current || next.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível ler a planilha."); }
    finally { setReading(false); }
  }
  function chooseSheet(next: string) {
    const found = sheets.find(item => item.name === next);
    if (found) { setSheetName(next); setFields(guessFields(found.rows[0] ?? [])); }
  }
  async function upload() {
    if (!file || !rows.length) return;
    setError(null); setProgress(0);
    let target = listId ?? undefined;
    try {
      for (let at = 0; at < rows.length; at += MAX_OWN_BASE_IMPORT_ROWS) {
        const result = await apiOwnBaseImport(getToken, { ...(target ? { listId: target } : {}), name: name.trim() || file.name, fileName: file.name,
          rows: rows.slice(at, at + MAX_OWN_BASE_IMPORT_ROWS), done: at + MAX_OWN_BASE_IMPORT_ROWS >= rows.length });
        target = result.listId;
        setProgress(Math.min(rows.length, at + MAX_OWN_BASE_IMPORT_ROWS) / rows.length);
      }
      onDone(`${rows.length.toLocaleString("pt-BR")} empresas de ${file.name} estão na base.`);
    } catch (cause) {
      setProgress(null);
      setError(`${cause instanceof Error ? cause.message : "A subida parou."} O que já subiu continua salvo; subir de novo atualiza sem duplicar.`);
    }
  }
  async function copyPrompt() {
    try { await navigator.clipboard.writeText(AI_PROMPT); setCopied(true); } catch { setCopied(false); }
  }

  return <section className="own-base own-base-import" aria-label="Subir planilha">
    <div className="own-base-pane own-base-import-pane">
      <div className="own-base-bar">
        <div><h2>Subir planilha</h2><span>{file ? `${file.name}${sheets.length > 1 ? "" : ` · ${(sheet?.rows.length ?? 1) - 1} linhas`}` : "Excel (.xlsx) ou CSV"}</span></div>
        <button type="button" className="own-base-plain" disabled={progress !== null} onClick={onCancel}>Voltar</button>
      </div>
      {!file ? <div className="own-base-drop">
        <FileSpreadsheet size={28} aria-hidden="true" />
        <p>Envie a planilha como ela está. O Talk reconhece as colunas e você confere antes de gravar.</p>
        <label className="own-base-go">{reading ? "Lendo…" : "Escolher arquivo"}<input type="file" accept=".xlsx,.csv,text/csv" hidden disabled={reading} onChange={event => void pick(event.target.files?.[0])} /></label>
        {error ? <p className="own-base-error" role="alert">{error}</p> : null}
        <details className="own-base-help">
          <summary>Planilha bagunçada? Use o modelo ou peça para o ChatGPT arrumar</summary>
          <p><button type="button" className="own-base-link" onClick={downloadTemplate}>Baixar modelo</button> · <button type="button" className="own-base-link" onClick={() => void copyPrompt()}>{copied ? "Prompt copiado" : "Copiar prompt"}</button></p>
          <pre>{AI_PROMPT}</pre>
        </details>
      </div> : <div className="own-base-import-body">
        <div className="own-base-table">
          {sheets.length > 1 ? <label className="own-base-sheet">Aba da planilha<select value={sheetName} onChange={event => chooseSheet(event.target.value)}>
            {sheets.map(item => <option key={item.name} value={item.name}>{item.name} ({item.rows.length - 1} linhas)</option>)}</select></label> : null}
          <table>
            <thead><tr><th>Coluna da planilha</th><th>No Talk</th><th>Exemplo</th></tr></thead>
            <tbody>{(sheet?.rows[0] ?? []).map((header, index) => <tr key={`${index}-${header}`} className={fields[index] === "ignore" ? "is-muted" : undefined}>
              <td>{header || `Coluna ${index + 1}`}</td>
              <td><select aria-label={`O que é ${header}`} value={fields[index] ?? "ignore"} disabled={progress !== null}
                onChange={event => setFields(current => current.map((field, at) => at === index ? event.target.value as Field : field))}>
                {FIELDS.map(field => <option key={field} value={field}>{FIELD_LABELS[field]}</option>)}</select></td>
              <td className="own-base-faint own-base-example">{sheet?.rows.slice(1).find(row => row[index])?.[index] ?? "—"}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="own-base-summary">
          <h2>Antes de gravar</h2>
          <dl>
            <div><dt>Empresas</dt><dd>{summary.companies.toLocaleString("pt-BR")}</dd></div>
            <div><dt>Com telefone válido</dt><dd>{summary.withPhone.toLocaleString("pt-BR")}</dd></div>
            <div><dt>Sem telefone válido</dt><dd>{(summary.companies - summary.withPhone).toLocaleString("pt-BR")}</dd></div>
            <div><dt>Regiões</dt><dd>{summary.regions}</dd></div>
          </dl>
          <p className="own-base-faint">Telefones sem DDD ficam fora dos disparos. Empresas repetidas (mesmo CNPJ ou telefone) são unidas.</p>
          {!fields.includes("company") || !fields.includes("phone") ? <p className="own-base-error">Escolha qual coluna é a Empresa e qual é o Telefone.</p> : null}
          <label>Nome da base<input value={name} maxLength={160} disabled={progress !== null || Boolean(listId)} onChange={event => setName(event.target.value)} /></label>
          {listId ? <p className="own-base-faint">As empresas entram na base atual; as que já estão nela são atualizadas.</p> : null}
          {progress !== null ? <div className="own-base-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><i style={{ width: `${progress * 100}%` }} /><span>Subindo… {Math.round(progress * 100)}%</span></div> : null}
          {error ? <p className="own-base-error" role="alert">{error}</p> : null}
          <button type="button" className="own-base-go" disabled={progress !== null || !rows.length || !fields.includes("company") || !fields.includes("phone")} onClick={() => void upload()}>
            Subir {summary.companies.toLocaleString("pt-BR")} empresas</button>
        </div>
      </div>}
    </div>
  </section>;
}
