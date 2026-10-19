import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Download, LoaderCircle, MoreHorizontal, Plus, Search, Trash2, Upload, Users, X, Zap } from "lucide-react";
import type { QuickReplyDto, QuickReplyInput } from "../../app/api";
import { fieldLabel, renderTemplate, TEMPLATE_FIELDS, type TemplateValues } from "./quick-reply-template";
import "./quick-replies.css";

const fold = (value: string) => value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

export function quickReplyMatchesQuery(reply: Pick<QuickReplyDto, "title" | "body" | "category"> & Partial<Pick<QuickReplyDto, "shortcut">>, query: string) {
  const normalizedQuery = fold(query.trim());
  if (!normalizedQuery) return true;
  return [reply.title, reply.body, reply.category ?? "", reply.shortcut ?? ""].some(value => fold(value).includes(normalizedQuery));
}

/** For "/bem": shortcuts that start with it first, then titles, then anything that contains it. */
export function rankQuickReplies(replies: QuickReplyDto[], query: string) {
  const q = fold(query.trim());
  if (!q) return replies;
  const score = (reply: QuickReplyDto) => (reply.shortcut ?? "").startsWith(q) ? 0 : fold(reply.title).startsWith(q) ? 1
    : fold(reply.title).split(/\s+/).some(word => word.startsWith(q)) ? 2 : quickReplyMatchesQuery(reply, q) ? 3 : 9;
  return replies.map(reply => ({ reply, rank: score(reply) })).filter(item => item.rank < 9).sort((a, b) => a.rank - b.rank).map(item => item.reply);
}

export function quickReplyMutationErrorMessage(error: unknown, fallbackMessage: string) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallbackMessage;
}

/** The body with its fields shown as small pills, for lists and previews. */
function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\{\{?[^{}]{2,30}\}?\})/g);
  return <>{parts.map((part, index) => /^\{/.test(part) ? <span key={index} className="quick-reply-field">{fieldLabel(part)}</span> : part)}</>;
}

/** The "/" menu above the composer: filtered as you type, ↑ ↓ to choose, Enter to use, Esc to close. */
export function SlashQuickReplies({ replies, query, activeIndex, loading, fillingId, onPick, onHover, onManage }: {
  replies: QuickReplyDto[]; query: string; activeIndex: number; loading: boolean; fillingId: string | null;
  onPick: (reply: QuickReplyDto) => void; onHover: (index: number) => void; onManage: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [activeIndex]);
  return <div className="slash-menu" role="listbox" aria-label="Mensagens padrão">
    <header><Zap size={14} aria-hidden="true" /><span>Mensagens padrão{query ? <> · <b>/{query}</b></> : null}</span><small>↑ ↓ escolher · Enter usar · Esc fechar</small></header>
    <div className="slash-menu-list" ref={list}>
      {replies.map((reply, index) => <button type="button" role="option" aria-selected={index === activeIndex} data-index={index} key={reply.id}
        className={index === activeIndex ? "is-active" : undefined} onMouseEnter={() => onHover(index)}
        onMouseDown={event => { event.preventDefault(); onPick(reply); }}>
        <span className="slash-menu-title"><strong>{reply.title}</strong>{reply.shortcut ? <code>/{reply.shortcut}</code> : null}
          {reply.shared ? <span className="quick-reply-shared"><Users size={11} aria-hidden="true" />equipe</span> : null}
          {fillingId === reply.id ? <span className="slash-menu-filling"><LoaderCircle size={12} aria-hidden="true" />preenchendo nome…</span> : null}</span>
        <span className="slash-menu-body"><Highlighted text={reply.body} /></span>
      </button>)}
      {!replies.length ? <p className="slash-menu-empty">{loading ? "Carregando mensagens…" : query ? `Nenhuma mensagem para “/${query}”.` : "Você ainda não tem mensagens padrão."}</p> : null}
    </div>
    <footer><button type="button" onMouseDown={event => { event.preventDefault(); onManage(); }}><Plus size={13} aria-hidden="true" />Criar ou editar mensagens</button></footer>
  </div>;
}

type Draft = { id: string | null; title: string; shortcut: string; category: string; body: string };
const emptyDraft: Draft = { id: null, title: "", shortcut: "", category: "", body: "" };
const shortcutOf = (value: string) => fold(value).replace(/[^a-z0-9]+/g, "").slice(0, 40);

/**
 * Where quick replies are created and edited: the list on the left, the editor on the right with buttons for the fields
 * and a live preview. Packs can be exported and imported from a discreet menu.
 */
export function QuickRepliesManager({ replies, loading, error, sample, onClose, onUse, onCreate, onUpdate, onDelete, onImport }: {
  replies: QuickReplyDto[]; loading: boolean; error: string | null; sample: TemplateValues;
  onClose: () => void; onUse: (reply: QuickReplyDto) => void;
  onCreate: (input: QuickReplyInput) => Promise<QuickReplyDto>; onUpdate: (id: string, input: Partial<QuickReplyInput>) => Promise<QuickReplyDto>;
  onDelete: (id: string) => Promise<void>; onImport: (replies: QuickReplyInput[]) => Promise<{ created: number; skipped: number }>;
}) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [shortcutTouched, setShortcutTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [menu, setMenu] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal?.(); }, []);
  const filtered = useMemo(() => replies.filter(reply => quickReplyMatchesQuery(reply, query)), [replies, query]);
  const mine = filtered.filter(reply => !reply.shared), team = filtered.filter(reply => reply.shared);
  const preview = renderTemplate(draft.body, sample);
  const editing = draft.id ? replies.find(reply => reply.id === draft.id) : null;

  function open(reply: QuickReplyDto | null) {
    setNotice(null); setMenu(false); setShortcutTouched(Boolean(reply));
    setDraft(reply ? { id: reply.id, title: reply.title, shortcut: reply.shortcut ?? "", category: reply.category ?? "", body: reply.body } : emptyDraft);
  }
  function insertField(key: string) {
    const element = textarea.current;
    const token = `{${key}}`;
    const start = element?.selectionStart ?? draft.body.length, end = element?.selectionEnd ?? draft.body.length;
    const body = draft.body.slice(0, start) + token + draft.body.slice(end);
    setDraft({ ...draft, body });
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(start + token.length, start + token.length); });
  }
  async function save() {
    if (!draft.title.trim() || !draft.body.trim()) { setNotice({ tone: "error", text: "Dê um título e escreva a mensagem." }); return; }
    setBusy(true); setNotice(null);
    try {
      const input = { title: draft.title.trim(), body: draft.body.trim(), category: draft.category.trim() || null, shortcut: draft.shortcut.trim() || null };
      const saved = draft.id ? await onUpdate(draft.id, input) : await onCreate(input);
      open(saved); setNotice({ tone: "ok", text: "Mensagem salva." });
    } catch (cause) { setNotice({ tone: "error", text: quickReplyMutationErrorMessage(cause, "Não foi possível salvar.") }); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!draft.id || !window.confirm(`Excluir “${draft.title}”?`)) return;
    setBusy(true);
    try { await onDelete(draft.id); open(null); setNotice({ tone: "ok", text: "Mensagem excluída." }); }
    catch (cause) { setNotice({ tone: "error", text: quickReplyMutationErrorMessage(cause, "Não foi possível excluir.") }); }
    finally { setBusy(false); }
  }
  function exportPack() {
    setMenu(false);
    const pack = { kind: "prymeira-talk-quick-replies", version: 1, exportedAt: new Date().toISOString(),
      replies: replies.filter(reply => !reply.shared).map(({ title, body, category, shortcut }) => ({ title, body, category, shortcut })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "mensagens-padrao.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importPack(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; setMenu(false);
    if (!file) return;
    setBusy(true); setNotice(null);
    try {
      const data = JSON.parse(await file.text()) as { replies?: QuickReplyInput[] };
      if (!Array.isArray(data.replies) || !data.replies.length) throw new Error("Este arquivo não é um pacote de mensagens do Talk.");
      const result = await onImport(data.replies);
      setNotice({ tone: "ok", text: `${result.created} mensage${result.created === 1 ? "m importada" : "ns importadas"}${result.skipped ? ` · ${result.skipped} já existia${result.skipped === 1 ? "" : "m"}` : ""}.` });
    } catch (cause) { setNotice({ tone: "error", text: cause instanceof SyntaxError ? "Este arquivo não é um pacote de mensagens do Talk." : quickReplyMutationErrorMessage(cause, "Não foi possível importar.") }); }
    finally { setBusy(false); }
  }
  const item = (reply: QuickReplyDto) => <button type="button" key={reply.id} className={`qr-item${draft.id === reply.id ? " is-active" : ""}`} onClick={() => open(reply)}>
    <span className="qr-item-title"><strong>{reply.title}</strong>{reply.shortcut ? <code>/{reply.shortcut}</code> : null}</span>
    <span className="qr-item-body"><Highlighted text={reply.body} /></span>
    {reply.category ? <span className="qr-item-category">{reply.category}</span> : null}
  </button>;

  return <dialog className="qr-manager" ref={dialog} aria-label="Mensagens padrão" onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="qr-manager-shell">
      <header className="qr-manager-header">
        <div><h2>Mensagens padrão</h2><p>Digite <code>/</code> na conversa para usar. Os campos se preenchem com os dados do cliente.</p></div>
        <div className="qr-manager-tools">
          <div className="qr-menu">
            <button type="button" className="qr-icon" aria-label="Importar ou exportar" onClick={() => setMenu(!menu)}><MoreHorizontal size={18} /></button>
            {menu ? <div className="qr-menu-popover" role="menu">
              <button type="button" role="menuitem" onClick={exportPack} disabled={!replies.some(reply => !reply.shared)}><Download size={14} aria-hidden="true" />Exportar minhas mensagens</button>
              <button type="button" role="menuitem" onClick={() => fileInput.current?.click()}><Upload size={14} aria-hidden="true" />Importar pacote…</button>
            </div> : null}
            <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={event => void importPack(event)} />
          </div>
          <button type="button" className="qr-icon" aria-label="Fechar" onClick={onClose}><X size={18} /></button>
        </div>
      </header>
      <div className="qr-manager-body">
        <aside className="qr-list">
          <label className="qr-search"><Search size={14} aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por título, texto ou atalho" /></label>
          <button type="button" className="qr-new" onClick={() => open(null)}><Plus size={15} aria-hidden="true" />Nova mensagem</button>
          {error ? <p className="qr-error">{error}</p> : null}
          {loading && !replies.length ? <p className="qr-empty">Carregando…</p> : null}
          {mine.length ? <><h3>Minhas</h3>{mine.map(item)}</> : null}
          {team.length ? <><h3>Da equipe</h3>{team.map(item)}</> : null}
          {!loading && !filtered.length ? <p className="qr-empty">{query ? "Nada encontrado." : "Crie sua primeira mensagem →"}</p> : null}
        </aside>
        <section className="qr-editor">
          <div className="qr-row">
            <label>Título<input value={draft.title} maxLength={120} placeholder="Ex.: Boas-vindas"
              onChange={event => setDraft({ ...draft, title: event.target.value, shortcut: shortcutTouched ? draft.shortcut : shortcutOf(event.target.value) })} /></label>
            <label>Atalho<span className="qr-shortcut"><b>/</b><input value={draft.shortcut} maxLength={40} placeholder="boasvindas"
              onChange={event => { setShortcutTouched(true); setDraft({ ...draft, shortcut: shortcutOf(event.target.value) }); }} /></span></label>
            <label>Categoria<input value={draft.category} maxLength={80} placeholder="Opcional" onChange={event => setDraft({ ...draft, category: event.target.value })} /></label>
          </div>
          <label className="qr-body-label">Mensagem
            <textarea ref={textarea} value={draft.body} rows={6} maxLength={4000} placeholder="{saudacao}, {primeiro_nome}! Aqui é o {vendedor}…"
              onChange={event => setDraft({ ...draft, body: event.target.value })} /></label>
          <div className="qr-fields" aria-label="Inserir campo"><span>Inserir:</span>
            {TEMPLATE_FIELDS.map(field => <button type="button" key={field.key} onClick={() => insertField(field.key)}>{field.label}</button>)}</div>
          <div className="qr-preview"><span>Prévia</span>
            <p>{preview.text || <i>A mensagem aparece aqui.</i>}</p>
            <small>Exemplo com {sample.nome ?? "um cliente"}{sample.empresa ? ` · ${sample.empresa}` : ""}. Campo sem informação some da frase.</small></div>
          {notice ? <p className={`qr-notice is-${notice.tone}`} role="status">{notice.text}</p> : null}
          <footer className="qr-editor-actions">
            {draft.id ? <button type="button" className="qr-delete" disabled={busy} onClick={() => void remove()}><Trash2 size={14} aria-hidden="true" />Excluir</button> : <span />}
            <span className="qr-spacer" />
            {editing ? <button type="button" className="secondary-button" disabled={busy} onClick={() => onUse(editing)}>Usar na conversa</button> : null}
            <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? "Salvando…" : draft.id ? "Salvar alterações" : "Criar mensagem"}</button>
          </footer>
        </section>
      </div>
    </div>
  </dialog>;
}
