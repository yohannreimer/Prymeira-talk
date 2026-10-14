import type { MessageDto } from '@prymeira-talk/shared';

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** The separator between days, as WhatsApp writes it: "Hoje", "Ontem", the weekday this week, then the date. */
export function messageDayLabel(value: string, now = new Date()) {
  const date = new Date(value);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  if (days > 1 && days < 7) { const weekday = date.toLocaleDateString('pt-BR', { weekday: 'long' }); return weekday.charAt(0).toUpperCase() + weekday.slice(1); }
  return date.toLocaleDateString('pt-BR', date.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'long' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
}

type Placed = Pick<MessageDto, 'direction' | 'createdAt' | 'senderJid' | 'senderName' | 'type'>;
const author = (message: Placed, isGroup: boolean) =>
  `${message.direction}:${isGroup && message.direction === 'inbound' ? message.senderJid ?? message.senderName ?? '' : ''}`;

/**
 * Where a message sits in the thread: the first of a new day gets the day separator, and consecutive messages from the
 * same author form a run (photo only on the last one, tighter spacing), like WhatsApp.
 */
export function threadPlacement(messages: Placed[], index: number, isGroup: boolean) {
  const message = messages[index]!;
  const previous = messages[index - 1];
  const next = messages[index + 1];
  const day = dayKey(new Date(message.createdAt));
  const newDay = !previous || dayKey(new Date(previous.createdAt)) !== day;
  const joins = (other: Placed | undefined) => Boolean(other && other.type !== 'system' && message.type !== 'system'
    && author(other, isGroup) === author(message, isGroup) && dayKey(new Date(other.createdAt)) === day);
  return { newDay, startsRun: newDay || !joins(previous), endsRun: !joins(next) };
}
