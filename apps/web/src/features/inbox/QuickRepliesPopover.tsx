import { Plus, Pencil, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import type { QuickReplyDto } from "../../app/api";

export function quickReplyMatchesQuery(reply: QuickReplyDto, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [reply.title, reply.body, reply.category ?? ""].some((value) =>
    value.toLowerCase().includes(normalizedQuery)
  );
}

interface QuickRepliesPopoverProps {
  replies: QuickReplyDto[];
  isLoading: boolean;
  error: string | null;
  onInsert: (body: string) => void;
  onCreate: (input: { title: string; body: string; category?: string | null }) => Promise<void>;
  onUpdate: (id: string, input: Partial<{ title: string; body: string; category: string | null }>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function QuickRepliesPopover({
  replies,
  isLoading,
  error,
  onInsert,
  onCreate,
  onUpdate,
  onDelete
}: QuickRepliesPopoverProps) {
  const [query, setQuery] = useState("");
  const [editingReply, setEditingReply] = useState<QuickReplyDto | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("");

  const filteredReplies = useMemo(
    () => replies.filter((reply) => quickReplyMatchesQuery(reply, query)),
    [query, replies]
  );

  function startCreate() {
    setEditingReply(null);
    setTitle("");
    setBody("");
    setCategory("");
  }

  function startEdit(reply: QuickReplyDto) {
    setEditingReply(reply);
    setTitle(reply.title);
    setBody(reply.body);
    setCategory(reply.category ?? "");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (editingReply) {
      await onUpdate(editingReply.id, { title, body, category: category || null });
    } else {
      await onCreate({ title, body, category: category || null });
    }
    startCreate();
  }

  return (
    <div className="quick-replies-popover" aria-label="Mensagens padrao">
      <div className="quick-replies-header">
        <strong>Mensagens padrao</strong>
        <button type="button" className="composer-tool" onClick={startCreate} aria-label="Nova mensagem padrao">
          <Plus size={15} aria-hidden="true" />
        </button>
      </div>
      <input
        className="quick-replies-search"
        placeholder="Buscar por titulo, texto ou categoria"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? <p className="error-note">{error}</p> : null}
      {isLoading ? <p className="list-note">Carregando mensagens...</p> : null}
      <div className="quick-replies-list">
        {filteredReplies.map((reply) => (
          <article className="quick-reply-item" key={reply.id}>
            <button type="button" className="quick-reply-insert" onClick={() => onInsert(reply.body)}>
              <strong>{reply.title}</strong>
              <span>{reply.body}</span>
              {reply.category ? <small>{reply.category}</small> : null}
            </button>
            <button type="button" className="icon-button" onClick={() => startEdit(reply)} aria-label="Editar mensagem padrao">
              <Pencil size={14} aria-hidden="true" />
            </button>
            <button type="button" className="icon-button danger" onClick={() => void onDelete(reply.id)} aria-label="Apagar mensagem padrao">
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </article>
        ))}
      </div>
      <form className="quick-reply-form" onSubmit={submit}>
        <input required placeholder="Titulo" value={title} onChange={(event) => setTitle(event.target.value)} />
        <input placeholder="Categoria" value={category} onChange={(event) => setCategory(event.target.value)} />
        <textarea required placeholder="Mensagem" value={body} onChange={(event) => setBody(event.target.value)} />
        <button className="primary-button" type="submit">
          {editingReply ? "Salvar" : "Criar"}
        </button>
      </form>
    </div>
  );
}
