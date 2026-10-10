import { Check, CheckCheck, CircleAlert, Clock3 } from 'lucide-react';
import type { MessageStatus } from '@prymeira-talk/shared';

/** WhatsApp's ticks for a message we sent: clock while sending, ✓ sent, ✓✓ delivered, blue ✓✓ read. */
export function MessageTicks({ status }: { status: MessageStatus }) {
  const icon = status === 'pending' ? <Clock3 size={13} role="img" aria-label="Enviando" />
    : status === 'failed' ? <CircleAlert size={13} role="img" aria-label="Não enviada" />
    : status === 'sent' ? <Check size={15} role="img" aria-label="Enviada" />
    : <CheckCheck size={15} role="img" aria-label={status === 'read' ? 'Lida' : 'Entregue'} />;

  // Reserve the same box for every state, including the hidden inline metadata spacer.
  return <span className={`message-ticks${status === 'pending' ? ' is-pending' : status === 'failed' ? ' is-failed' : status === 'read' ? ' is-read' : ''}`}>{icon}</span>;
}
