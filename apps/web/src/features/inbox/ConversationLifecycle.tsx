import './conversation-lifecycle.css';
import { useEffect, useRef, useState } from 'react';
import { apiConfirmCtwaSale, apiGetCtwaLifecycle, type CtwaLifecycleCapability, type CtwaLifecycleItem } from '../../app/api';

/** Parse decimal BRL without binary-float rounding or accepting extra precision. */
export function parseBrlCents(input: string): number | null {
  const raw = input.trim().replace(/^R\$\s*/, '');
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.replace(/\./g, '').split(',');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 100000000000000 ? cents : null;
}
export function lifecycleStateLabel(state: string) {
  const labels: Record<string, string> = {
    pending_validation: 'Na fila no Talk', tracking_forwarding: 'Enviando ao Tracking',
    tracking_retry: 'Aguardando confirmação do Tracking', tracking_pending: 'Pendente no Tracking',
    tracking_accepted: 'Aceita pela Meta', tracking_rejected: 'Rejeitada pela Meta',
    tracking_unknown: 'Resultado Meta incerto', tracking_blocked: 'Bloqueada no Tracking'
  };
  return labels[state] ?? 'Aguardando confirmação';
}
export function ConversationLifecycle({ conversationId, getToken }: { conversationId: string; getToken: () => Promise<string | null> }) {
  const [snapshot, setSnapshot] = useState<{ conversationId: string; capability: CtwaLifecycleCapability } | null>(null);
  useEffect(() => {
    let active = true, reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try { const capability = await apiGetCtwaLifecycle(getToken, conversationId); if (active) setSnapshot({ conversationId, capability }); }
      catch { /* Optional capability remains hidden until confirmed by the scoped API. */ }
      finally { reading = false; }
    };
    void read();
    const interval = setInterval(() => void read(), 15000);
    return () => { active = false; clearInterval(interval); };
  }, [conversationId, getToken]);
  if (snapshot?.conversationId !== conversationId || !snapshot.capability.enabled || !snapshot.capability.native) return null;
  return <LifecyclePanel key={conversationId} conversationId={conversationId} getToken={getToken} items={snapshot.capability.items} />;
}
function LifecyclePanel({ conversationId, getToken, items }: { conversationId: string; getToken: () => Promise<string | null>; items: CtwaLifecycleItem[] }) {
  const [orderId, setOrderId] = useState(''), [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const [receipt, setReceipt] = useState<CtwaLifecycleItem | null>(null);
  const busy = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const currentReceipt = items.find(item => item.id === receipt?.id) ?? receipt;
  const stages = receipt && !items.some(item => item.id === receipt.id) ? [receipt, ...items] : items;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    const valueCents = parseBrlCents(amount), reference = orderId.trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(reference)) { setError('Informe uma referência de venda com letras, números, ponto, hífen, dois-pontos ou sublinhado.'); return; }
    if (valueCents === null) { setError('Informe um valor positivo em reais, com até duas casas decimais (ex.: 1.234,56).'); return; }
    busy.current = true; setSaving(true); setError(null);
    try {
      const result = await apiConfirmCtwaSale(getToken, conversationId, { orderId: reference, valueCents, currency: 'BRL' });
      if (active.current) setReceipt(result);
    } catch (failure) {
      const messages: Record<string, string> = {
        sale_conflict: 'Essa referência já foi usada com outro valor ou origem. Confira a venda registrada.',
        lifecycle_disabled: 'As conversões não estão disponíveis para esta conta.',
        native_attribution_required: 'Esta conversa não tem uma origem de anúncio confirmada.'
      };
      if (active.current) setError(failure instanceof Error ? messages[failure.message] ?? 'Não foi possível confirmar. Repita com a mesma referência e valor.' : 'Não foi possível confirmar. Repita com a mesma referência e valor.');
    } finally { busy.current = false; if (active.current) setSaving(false); }
  }
  return <section className="context-card ctwa-lifecycle" aria-label="Conversões do anúncio">
    <div className="context-card-title">Conversões do anúncio</div>
    <p>Confirme uma venda concluída. A referência e o valor ficam registrados para evitar duplicação.</p>
    {stages.length ? <ul>{stages.map(item => <li key={item.id}>
      {item.eventName === 'QualifiedLead' ? 'Reunião confirmada' : `Venda ${item.orderId ?? ''}`}: {lifecycleStateLabel(item.state)}
      {item.valueCents !== null ? ` · ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(item.valueCents / 100)}` : ''}
    </li>)}</ul> : null}
    <form onSubmit={event => void submit(event)} aria-busy={saving}>
      <label>Referência da venda<input name="saleReference" value={orderId} maxLength={128} required disabled={saving} aria-invalid={Boolean(error)} autoComplete="off" onChange={event => setOrderId(event.target.value)} /></label>
      <label>Valor em reais<input name="saleAmount" value={amount} required disabled={saving} aria-invalid={Boolean(error)} inputMode="decimal" placeholder="1.234,56" autoComplete="off" onChange={event => setAmount(event.target.value)} /></label>
      {error ? <p className="error-note" role="alert">{error}</p> : null}
      {currentReceipt ? <p role="status">Venda {currentReceipt.orderId} registrada: {lifecycleStateLabel(currentReceipt.state)}.</p> : null}
      <button type="submit" disabled={saving}>{saving ? 'Registrando…' : 'Confirmar venda'}</button>
    </form>
  </section>;
}
