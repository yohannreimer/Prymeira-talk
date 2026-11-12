import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { getQrDisplaySource, type ExtensionAccount, type ExtensionConnection } from '@prymeira-talk/shared';
import { runtimeRequest, type AccountContext } from './protocol';
import { Icon } from './ui';

function ConnectionQr({ code, expiresAt, now }: { code: string; expiresAt: string; now: number }) {
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true; setImage(null); setFailed(false);
    const source = getQrDisplaySource(code);
    if (source?.kind === 'image') setImage(source.src);
    else if (source) void QRCode.toDataURL(source.payload, { errorCorrectionLevel: 'M', margin: 3, width: 260 })
      .then(value => { if (active) setImage(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [code]);
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return <div className="recovery-qr">
    {seconds === 0 ? <p role="status">QR code expirado. Atualizando…</p> : image ? <img alt="QR code para reconectar este WhatsApp ao Talk" src={image} width="260" height="260"/>
      : <p role="status">{failed ? 'Não foi possível exibir o QR code. Tente gerar outro.' : 'Preparando QR code…'}</p>}
    {seconds > 0 && <p className="helper">Código válido por {seconds}s. A atualização é automática.</p>}
  </div>;
}

/** Mounted with an account/tenant/tab key: old QR and late responses never survive an account switch. */
export function ConnectionRecovery({ context, account, initialAvailable, onAvailability }: {
  context: AccountContext; account: ExtensionAccount; initialAvailable: boolean; onAvailability: (available: boolean) => void;
}) {
  const [connection, setConnection] = useState<ExtensionConnection | null>(null);
  const [qr, setQr] = useState<ExtensionConnection['qr']>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const busyRef = useRef(false), alive = useRef(true), retryUntil = useRef(0), retryAt = useRef(0);
  const callback = useRef(onAvailability); callback.current = onAvailability;
  const available = connection?.available ?? initialAvailable;
  async function request(reconnect = false, manual = false) {
    if (busyRef.current || !alive.current) return;
    if (manual) retryUntil.current = Date.now() + 120_000;
    if (reconnect) retryAt.current = Date.now() + 10_000;
    busyRef.current = true; setBusy(true);
    try {
      const result = await runtimeRequest<ExtensionConnection>({ type: 'CONNECTION', context, account, reconnect });
      if (!alive.current) return;
      if (result.channelId !== account.channelId) throw new Error('A conta mudou. Atualize o painel.');
      setConnection(result); setError(null); callback.current(result.available);
      if (result.available) { setQr(null); retryUntil.current = 0; }
      else if (reconnect) setQr(result.qr);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'Não foi possível consultar a conexão. Tente novamente.');
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    void request();
    const status = setInterval(() => void request(), 5_000);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => { alive.current = false; retryUntil.current = 0; clearInterval(status); clearInterval(clock); };
  }, []);
  useEffect(() => {
    if (available || !connection?.canReconnect || !retryUntil.current || now < retryAt.current) return;
    if (now >= retryUntil.current) { retryUntil.current = 0; setQr(null); setError('A conexão demorou para voltar. Toque em Reconectar para tentar novamente.'); return; }
    if (!qr || Date.parse(qr.expiresAt) <= now + 2_000) void request(true);
  }, [now, available, connection?.canReconnect, qr]);
  // A functional primary OR reserve is healthy here: no degraded/redundancy banner or success panel.
  if (available) return null;
  return <section className="connection-recovery" aria-label="Reconexão do WhatsApp">
    <div className="recovery-heading"><Icon name="alert"/><h2>Seu WhatsApp está desconectado do Talk</h2></div>
    <p>Nenhuma conexão está disponível para este número.</p>
    {error && <p className="recovery-error" role="alert">{error}</p>}
    {connection?.pending && !qr && !error && <p role="status">Preparando a conexão. O QR code aparecerá aqui.</p>}
    {qr && <><ConnectionQr key={`${qr.connectionId}:${qr.expiresAt}:${qr.code}`} code={qr.code} expiresAt={qr.expiresAt} now={now}/>
      <ol><li>Abra o WhatsApp no celular do número <strong>{connection?.phoneNumber}</strong>.</li>
        <li>Entre em <strong>Aparelhos conectados → Conectar aparelho</strong>.</li>
        <li>Escaneie este código. O painel volta automaticamente quando a conexão for confirmada.</li></ol></>}
    {connection?.canReconnect ? <button className="primary wide" disabled={busy} onClick={() => void request(true, true)}>
      <Icon name="refresh" className={busy ? 'is-loading' : ''}/>{busy ? 'Conectando…' : qr ? 'Atualizar QR code' : 'Reconectar'}</button>
      : connection ? <p>Peça ao responsável pelo canal para reconectar este número.</p>
      : <button className="secondary wide" disabled={busy} onClick={() => void request()}>{busy ? 'Verificando conexão…' : 'Tentar novamente'}</button>}
  </section>;
}
