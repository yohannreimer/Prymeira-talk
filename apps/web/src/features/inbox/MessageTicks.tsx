import { Check, CheckCheck, CircleAlert, Clock3 } from 'lucide-react';
import type { MessageStatus } from '@prymeira-talk/shared';

/** WhatsApp's ticks for a message we sent: clock while sending, ✓ sent, ✓✓ delivered, blue ✓✓ read. */
export function MessageTicks({ status }: { status: MessageStatus }) {
  if (status === 'pending') return <Clock3 className="message-ticks is-pending" size={13} role="img" aria-label="Enviando" />;
  if (status === 'failed') return <CircleAlert className="message-ticks is-failed" size={13} role="img" aria-label="Não enviada" />;
  if (status === 'sent') return <Check className="message-ticks" size={15} role="img" aria-label="Enviada" />;
  return <CheckCheck className={`message-ticks${status === 'read' ? ' is-read' : ''}`} size={15} role="img" aria-label={status === 'read' ? 'Lida' : 'Entregue'} />;
}
