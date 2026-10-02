import { useCallback, useEffect, useState } from 'react';
import { apiListOutboundReview, apiResolveOutboundReview, type OutboundReviewItem } from '../../app/api';

const KIND_LABEL: Record<string, string> = { text: 'Texto', media: 'Arquivo', audio: 'Áudio', contact: 'Contato', template: 'Modelo' };

/** Sends the system could not confirm: the connection answered too late or not at all, so the message may or may
 * not have reached the customer. Nothing is resent automatically (that could message the customer twice). A person
 * checks the customer's WhatsApp and records what happened. Renders nothing when there is nothing to review. */
export function OutboundReviewPanel({ getToken, refreshKey }: { getToken: () => Promise<string | null>; refreshKey?: number }) {
  const [items, setItems] = useState<OutboundReviewItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await apiListOutboundReview(getToken)); setError(null); }
    catch { /* a failed refresh keeps what is on screen */ }
  }, [getToken]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function resolve(item: OutboundReviewItem, delivered: boolean) {
    setBusyId(item.id); setError(null);
    try { await apiResolveOutboundReview(getToken, item.id, delivered); setItems((current) => current.filter((candidate) => candidate.id !== item.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível registrar a revisão.'); }
    finally { setBusyId(null); }
  }

  if (items.length === 0) return null;
  return (
    <section className="context-card" aria-label="Envios em revisão" style={{ margin: '0 16px 12px' }}>
      <div className="context-card-title">Envios em revisão ({items.length})</div>
      <p className="list-note">A conexão não confirmou estes envios. Confira no WhatsApp do cliente e diga se a mensagem chegou. Nada é reenviado automaticamente.</p>
      {error ? <p className="error-note" role="alert">{error}</p> : null}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        {items.map((item) => (
          <li key={item.id} data-dispatch-id={item.id} style={{ display: 'grid', gap: 6 }}>
            <div>
              <strong>{KIND_LABEL[item.kind] ?? item.kind}</strong> para {item.destination} · {new Date(item.createdAt).toLocaleString('pt-BR')}
              {item.preview ? <div className="list-note">“{item.preview}”</div> : null}
            </div>
            <div className="channel-row-actions">
              <button className="secondary-button" type="button" disabled={busyId === item.id} onClick={() => void resolve(item, true)}>Chegou ao cliente</button>
              <button className="secondary-button" type="button" disabled={busyId === item.id} onClick={() => void resolve(item, false)}>Não chegou</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
