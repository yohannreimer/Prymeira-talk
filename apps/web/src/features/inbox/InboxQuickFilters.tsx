import type { InboxView } from "@prymeira-talk/shared";
import { Bookmark, MessageCircleMore, MessageCircleReply } from "lucide-react";

const filters = [
  { id: "unread", label: "Não lidas no Talk", Icon: MessageCircleMore },
  { id: "marked", label: "Marcadas pela equipe", Icon: Bookmark },
  { id: "reply", label: "Responder", Icon: MessageCircleReply }
] as const;

export function InboxQuickFilters({ value, onChange }: {
  value: InboxView;
  onChange(view: Exclude<InboxView, "handoff">): void;
}) {
  return <div className="inbox-quick-filters" role="group" aria-label="Filtros rápidos">
    {filters.map(({ id, label, Icon }) => (
      <button
        key={id}
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={value === id}
        className={value === id ? "is-active" : ""}
        onClick={() => onChange(value === id ? "all" : id)}
      ><Icon size={18} strokeWidth={1.9} aria-hidden="true" /></button>
    ))}
  </div>;
}
