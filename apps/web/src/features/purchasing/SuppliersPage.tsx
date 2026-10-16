import { useCallback, useEffect, useRef, useState } from "react";
import type { PriceHistoryDto, SupplierDto, SupplierInput } from "@prymeira-talk/shared";
import { Ban, Check, FileSpreadsheet, Pencil, Plus, Search, Star, Store, Trash2, Upload } from "lucide-react";
import { useTalkAuth } from "../../app/auth";
import { readSpreadsheet, bestSheet } from "../leads/spreadsheet";
import { formatPhone, money, quantity, shortDate } from "./format";
import { purchasingApi } from "./purchasing-api";
import { pricesFromSheet, suppliersFromSheet } from "./spreadsheet-map";
import { Avatar, ConfirmButton, Drawer, EmptyState, Field, Skeleton, Tabs, useToast } from "./ui";

type Tab = "suppliers" | "prices";

export function SuppliersPage() {
  const [tab, setTab] = useState<Tab>("suppliers");
  return (
    <div className="po-stack">
      <header className="po-head">
        <div>
          <h1>Fornecedores</h1>
          <p>Quem a IA pode chamar para cotar, e quanto você já pagou por cada item.</p>
        </div>
      </header>
      <Tabs label="Fornecedores e preços" onChange={setTab} value={tab} options={[{ value: "suppliers", label: "Fornecedores" }, { value: "prices", label: "Preços pagos" }]} />
      <div className="po-tab-panel" key={tab}>{tab === "suppliers" ? <SuppliersTab /> : <PricesTab />}</div>
    </div>
  );
}

function useDebounced(value: string, ms = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(value), ms); return () => window.clearTimeout(timer); }, [value, ms]);
  return debounced;
}

function SuppliersTab() {
  const { getToken } = useTalkAuth();
  const toast = useToast();
  const [suppliers, setSuppliers] = useState<SupplierDto[] | null>(null);
  const [search, setSearch] = useState("");
  const term = useDebounced(search);
  const [editing, setEditing] = useState<SupplierDto | "new" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => {
    purchasingApi.listSuppliers(getToken, term).then(setSuppliers).catch((error: unknown) => {
      setSuppliers([]); toast(error instanceof Error ? error.message : "Não foi possível carregar.", "error");
    });
  }, [getToken, term, toast]);
  useEffect(load, [load]);

  async function patch(supplier: SupplierDto, input: Partial<SupplierInput>, done: string) {
    setSuppliers((current) => current?.map((row) => row.id === supplier.id ? { ...row, ...input } as SupplierDto : row) ?? null);
    try { await purchasingApi.updateSupplier(getToken, supplier.id, input); toast(done); }
    catch (error) { toast(error instanceof Error ? error.message : "Não foi possível salvar.", "error"); load(); }
  }

  async function importFile(file: File) {
    setImporting(true);
    try {
      const sheet = bestSheet(await readSpreadsheet(file));
      const parsed = suppliersFromSheet(sheet?.rows ?? []);
      if (parsed.missing.length) throw new Error(`Não achei a coluna de ${parsed.missing.join(" e ")} na planilha.`);
      if (!parsed.rows.length) throw new Error("A planilha não tem fornecedores.");
      const result = await purchasingApi.importSuppliers(getToken, parsed.rows.slice(0, 2000));
      toast(`${result.created} novos, ${result.updated} atualizados${result.rejected.length ? `, ${result.rejected.length} com problema (linha ${result.rejected[0]!.row + 1}: ${result.rejected[0]!.reason})` : ""}`,
        result.rejected.length && !result.created && !result.updated ? "error" : "ok");
      load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Não foi possível importar.", "error");
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="po-stack-sm">
      <div className="po-toolbar">
        <div className="po-search"><Search size={15} aria-hidden="true" /><input aria-label="Buscar fornecedor" onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nome, cidade, WhatsApp ou categoria" value={search} /></div>
        <input accept=".xlsx,.csv" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} ref={fileInput} type="file" />
        <button className="po-btn po-btn-ghost" disabled={importing} onClick={() => fileInput.current?.click()} title="Colunas: Fornecedor, WhatsApp, Contato, Cidade, Categorias" type="button">
          {importing ? <span className="po-spinner" aria-hidden="true" /> : <Upload size={15} aria-hidden="true" />} Importar planilha
        </button>
        <button className="po-btn po-btn-primary" onClick={() => setEditing("new")} type="button"><Plus size={15} aria-hidden="true" /> Fornecedor</button>
      </div>

      {!suppliers ? <div className="po-panel"><Skeleton lines={5} /></div> : null}
      {suppliers && !suppliers.length ? (
        <EmptyState icon={<Store size={24} />} title={term ? "Nenhum fornecedor encontrado" : "Cadastre seus fornecedores"}
          text={term ? "Tente outro nome, cidade ou categoria." : "Adicione um por um ou importe a planilha que você já tem (colunas Fornecedor e WhatsApp)."}
          action={term ? undefined : <button className="po-btn po-btn-primary" onClick={() => setEditing("new")} type="button"><Plus size={15} aria-hidden="true" /> Fornecedor</button>} />
      ) : null}

      {suppliers && suppliers.length ? (
        <div className="po-table-wrap po-panel-flush">
          <table className="po-table">
            <thead><tr><th>Fornecedor</th><th>WhatsApp</th><th>Categorias</th><th>Respondeu</th><th>Ganhou</th><th><span className="po-sr">Ações</span></th></tr></thead>
            <tbody>
              {suppliers.map((supplier) => (
                <tr className={supplier.blocked ? "is-muted" : ""} key={supplier.id}>
                  <td>
                    <span className="po-cell-name">
                      <Avatar name={supplier.name} size={32} />
                      <span><b>{supplier.name}</b><small>{[supplier.contactName, supplier.city].filter(Boolean).join(" · ") || "—"}</small></span>
                    </span>
                  </td>
                  <td className="po-num">{formatPhone(supplier.phone)}</td>
                  <td>{supplier.categories.length ? <span className="po-tags">{supplier.categories.slice(0, 3).map((category) => <span key={category}>{category}</span>)}{supplier.categories.length > 3 ? <span>+{supplier.categories.length - 3}</span> : null}</span> : <span className="po-muted">—</span>}</td>
                  <td>{supplier.stats.invited ? (
                    <span className="po-rate"><span className="po-rate-bar"><i style={{ width: `${(supplier.stats.answered / supplier.stats.invited) * 100}%` }} /></span>{supplier.stats.answered}/{supplier.stats.invited}</span>
                  ) : <span className="po-muted">novo</span>}</td>
                  <td className="po-num">{supplier.stats.won || <span className="po-muted">—</span>}</td>
                  <td>
                    <span className="po-row-actions">
                      <button aria-label={supplier.preferred ? "Tirar dos preferidos" : "Marcar como preferido"} aria-pressed={supplier.preferred} className={`po-icon-btn po-star-btn${supplier.preferred ? " is-on" : ""}`}
                        onClick={() => void patch(supplier, { preferred: !supplier.preferred }, supplier.preferred ? "Saiu dos preferidos" : "Marcado como preferido")} title="Preferido: aparece primeiro" type="button"><Star size={15} /></button>
                      <button aria-label={supplier.blocked ? "Desbloquear" : "Bloquear"} aria-pressed={supplier.blocked} className={`po-icon-btn${supplier.blocked ? " is-danger" : ""}`}
                        onClick={() => void patch(supplier, { blocked: !supplier.blocked }, supplier.blocked ? "Desbloqueado" : "Bloqueado: a IA não vai chamar")} title="Bloqueado: nunca recebe pedido" type="button"><Ban size={15} /></button>
                      <button aria-label="Editar" className="po-icon-btn" onClick={() => setEditing(supplier)} type="button"><Pencil size={15} /></button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {editing ? (
        <SupplierDrawer onClose={() => setEditing(null)} supplier={editing === "new" ? null : editing}
          onSaved={(saved, removed) => {
            setEditing(null);
            setSuppliers((current) => removed ? current?.filter((row) => row.id !== saved.id) ?? null
              : current?.some((row) => row.id === saved.id) ? current.map((row) => row.id === saved.id ? saved : row) : [saved, ...(current ?? [])]);
          }} />
      ) : null}
    </div>
  );
}

function SupplierDrawer({ supplier, onClose, onSaved }: { supplier: SupplierDto | null; onClose: () => void; onSaved: (supplier: SupplierDto, removed?: boolean) => void }) {
  const { getToken } = useTalkAuth();
  const toast = useToast();
  const [form, setForm] = useState({
    name: supplier?.name ?? "", phone: supplier ? formatPhone(supplier.phone) : "", contactName: supplier?.contactName ?? "", email: supplier?.email ?? "",
    cnpj: supplier?.cnpj ?? "", city: supplier?.city ?? "", categories: supplier?.categories.join(", ") ?? "", notes: supplier?.notes ?? ""
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  const phoneOk = form.phone.replace(/\D/g, "").length >= 10;

  async function save() {
    if (!form.name.trim() || !phoneOk) { setError(!form.name.trim() ? "Informe o nome." : "WhatsApp com DDD."); return; }
    setSaving(true); setError(null);
    const input: SupplierInput = { name: form.name, phone: form.phone, contactName: form.contactName || null, email: form.email || null, cnpj: form.cnpj || null,
      city: form.city || null, notes: form.notes || null, categories: form.categories.split(",").map((value) => value.trim()).filter(Boolean) };
    try {
      const saved = supplier ? await purchasingApi.updateSupplier(getToken, supplier.id, input) : await purchasingApi.createSupplier(getToken, input);
      toast(supplier ? "Fornecedor salvo" : `${saved.name} cadastrado`);
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar.");
      setSaving(false);
    }
  }

  async function remove() {
    if (!supplier) return;
    try { await purchasingApi.archiveSupplier(getToken, supplier.id); toast(`${supplier.name} removido`); onSaved(supplier, true); }
    catch (cause) { toast(cause instanceof Error ? cause.message : "Não foi possível remover.", "error"); }
  }

  return (
    <Drawer onClose={onClose} title={supplier ? supplier.name : "Novo fornecedor"}
      footer={<>
        {supplier ? <ConfirmButton className="po-btn po-btn-ghost po-btn-danger" confirmLabel="Remover mesmo?" icon={<Trash2 size={15} aria-hidden="true" />} label="Remover" onConfirm={() => void remove()} /> : null}
        <span className="po-grow" />
        <button className="po-btn po-btn-ghost" onClick={onClose} type="button">Cancelar</button>
        <button className="po-btn po-btn-primary" disabled={saving} onClick={() => void save()} type="button">
          {saving ? <span className="po-spinner" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />} Salvar
        </button>
      </>}>
      <form className="po-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Field label="Empresa" htmlFor="po-s-name"><input id="po-s-name" onChange={set("name")} placeholder="Móveis Silva" value={form.name} /></Field>
        <div className="po-grid-2">
          <Field error={form.phone && !phoneOk ? "Inclua o DDD." : null} label="WhatsApp" htmlFor="po-s-phone">
            <input id="po-s-phone" inputMode="tel" onChange={set("phone")} placeholder="(47) 99999-0000" value={form.phone} />
          </Field>
          <Field label="Contato" htmlFor="po-s-contact"><input id="po-s-contact" onChange={set("contactName")} placeholder="Carla (vendas)" value={form.contactName} /></Field>
        </div>
        <div className="po-grid-2">
          <Field label="Cidade" htmlFor="po-s-city"><input id="po-s-city" onChange={set("city")} value={form.city} /></Field>
          <Field label="CNPJ" htmlFor="po-s-cnpj"><input id="po-s-cnpj" onChange={set("cnpj")} value={form.cnpj} /></Field>
        </div>
        <Field hint="Separe por vírgula. Ajuda a filtrar na hora de escolher para quem pedir." label="O que vende" htmlFor="po-s-cat">
          <input id="po-s-cat" onChange={set("categories")} placeholder="móveis, escritório" value={form.categories} />
        </Field>
        <Field label="E-mail" htmlFor="po-s-email"><input id="po-s-email" inputMode="email" onChange={set("email")} value={form.email} /></Field>
        <Field label="Observações" htmlFor="po-s-notes"><textarea id="po-s-notes" onChange={set("notes")} rows={3} value={form.notes} /></Field>
        {error ? <div className="po-alert po-alert-error" role="alert">{error}</div> : null}
        <button hidden type="submit" />
      </form>
    </Drawer>
  );
}

function PricesTab() {
  const { getToken } = useTalkAuth();
  const toast = useToast();
  const [rows, setRows] = useState<PriceHistoryDto[] | null>(null);
  const [search, setSearch] = useState("");
  const term = useDebounced(search);
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => {
    purchasingApi.listPrices(getToken, term).then(setRows).catch(() => setRows([]));
  }, [getToken, term]);
  useEffect(load, [load]);

  async function importFile(file: File) {
    setImporting(true);
    try {
      const sheet = bestSheet(await readSpreadsheet(file));
      const parsed = pricesFromSheet(sheet?.rows ?? []);
      if (parsed.missing.length) throw new Error(`Não achei a coluna de ${parsed.missing.join(", ")} na planilha.`);
      if (!parsed.rows.length) throw new Error("Nenhuma linha com item, preço e data.");
      const result = await purchasingApi.importPrices(getToken, parsed.rows.slice(0, 5000));
      const ignored = parsed.skipped + result.rejected.length;
      toast(`${result.created} preços importados${ignored ? `, ${ignored} linhas ignoradas` : ""}`);
      load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Não foi possível importar.", "error");
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="po-stack-sm">
      <div className="po-toolbar">
        <div className="po-search"><Search size={15} aria-hidden="true" /><input aria-label="Buscar item" onChange={(event) => setSearch(event.target.value)} placeholder="Buscar item" value={search} /></div>
        <input accept=".xlsx,.csv" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} ref={fileInput} type="file" />
        <button className="po-btn po-btn-primary" disabled={importing} onClick={() => fileInput.current?.click()} title="Colunas: Item, Fornecedor, Preço unitário, Data, Unidade, Quantidade" type="button">
          {importing ? <span className="po-spinner" aria-hidden="true" /> : <FileSpreadsheet size={15} aria-hidden="true" />} Importar planilha
        </button>
      </div>
      <p className="po-muted po-small">Cada compra aprovada entra aqui sozinha. O pedido mostra a última compra de cada item como referência.</p>
      {!rows ? <div className="po-panel"><Skeleton lines={5} /></div> : null}
      {rows && !rows.length ? (
        <EmptyState icon={<FileSpreadsheet size={24} />} title={term ? "Nenhum preço para esse item" : "Nenhum preço ainda"}
          text={term ? "Tente outro nome." : "Importe uma planilha com Item, Fornecedor, Preço unitário e Data, ou aprove um pedido."} />
      ) : null}
      {rows && rows.length ? (
        <div className="po-table-wrap po-panel-flush">
          <table className="po-table">
            <thead><tr><th>Item</th><th>Fornecedor</th><th className="po-right">Preço unitário</th><th className="po-right">Qtd.</th><th>Data</th><th>Origem</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><b>{row.itemName}</b></td>
                  <td>{row.supplierName ?? <span className="po-muted">—</span>}</td>
                  <td className="po-right po-num">{money(row.unitPriceCents)}{row.unit ? <small className="po-muted"> /{row.unit}</small> : null}</td>
                  <td className="po-right po-num">{row.quantity ? quantity(row.quantity) : "—"}</td>
                  <td className="po-num">{shortDate(row.paidAt)}</td>
                  <td>{row.source === "request" ? <span className="po-tag-green">pedido aprovado</span> : <span className="po-muted">planilha</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
