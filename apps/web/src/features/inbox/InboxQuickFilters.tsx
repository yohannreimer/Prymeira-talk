import type { InboxView } from "@prymeira-talk/shared";
import { Bookmark, MessageCircleMore, MessageCircleReply } from "lucide-react";

const filters = [
  { id: "unread", label: "Não lidas no Talk", short: "Não lidas", Icon: MessageCircleMore },
  { id: "marked", label: "Marcadas pela equipe", short: "Marcadas", Icon: Bookmark },
  { id: "reply", label: "Responder", short: "Responder", Icon: MessageCircleReply }
] as const;

export function InboxQuickFilters({ value, onChange }: {
  value: InboxView;
  onChange(view: Exclude<InboxView, "handoff">): void;
}) {
  return <div className="inbox-quick-filters" role="group" aria-label="Filtros rápidos">
    {filters.map(({ id, label, short, Icon }) => (
      <button
        key={id}
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={value === id}
        className={value === id ? "is-active" : ""}
        onClick={() => onChange(value === id ? "all" : id)}
      ><Icon size={16} strokeWidth={1.9} aria-hidden="true" /><span className="inbox-quick-filter-label" aria-hidden="true">{short}</span></button>
    ))}
  </div>;
}
