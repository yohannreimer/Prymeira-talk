import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, LoaderCircle, QrCode, Send, Smartphone, TriangleAlert, WifiOff } from 'lucide-react';
import type { ChannelDto, ChannelQrResultDto, RealtimeEvent } from '@prymeira-talk/shared';
import { apiDisconnectConnection, apiGetConnectionState, apiSetChannelRedundancy, apiStartConnectionQr } from '../../app/api';
import { ChannelQrView } from './ChannelQrView';
import { HistoryComparisonPanel } from './HistoryComparisonPanel';
import { applyQrUpdate, connectionDisplay, connectionSummary, qrKey } from './connection-display';
import './channel-connections.css';

type QrEvent = Extract<RealtimeEvent, { type: 'channel.qr_updated' }>;
type Display = ReturnType<typeof connectionDisplay>[number];

/** Problems worth telling a person, only while they matter (a disconnected or unhealthy connection). */
function problem(entry: Display): { tone: 'error' | 'warning'; text: string } | null {
  const error = entry.connection?.lastError;
  const troubled = entry.status !== 'connected' || entry.health === 'degraded' || entry.health === 'unhealthy';
  if (error === 'PHONE_MISMATCH') return { tone: 'error', text: 'Este QR foi lido por outro número. Escaneie com o celular do mesmo número da conexão principal.' };
  if (!troubled) return null;
  if (error === 'ENGINE_NOT_READY') return { tone: 'warning', text: 'O WhatsApp não carregou nesta conexão. Se continuar assim, desconecte e gere o QR Code de novo.' };
  if (error === 'RECEIVE_LOSS') return { tone: 'warning', text: 'Esta conexão deixou de receber algumas mensagens. Ela volta sozinha quando receber de novo.' };
  if (entry.health === 'unhealthy' && entry.status === 'connected') return { tone: 'warning', text: 'A conexão não está respondendo. Se continuar, gere o QR Code de novo.' };
  return null;
}

function Countdown({ expiresAt }: { expiresAt?: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  if (!expiresAt) return null;
  const seconds = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return <span className="connection-qr-timer">{seconds ? `Código válido por ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Código expirado — gere outro'}</span>;
}

/** The QR, with WhatsApp's own steps beside it, so anyone can relink a number without help. */
function QrStep({ provider, qr, phone }: { provider: string; qr: ChannelQrResultDto; phone: string | null }) {
  return <div className="connection-qr">
    <ChannelQrView key={qrKey(qr)} provider={provider} qrCode={qr.qrCode} expiresAt={qr.qr.expiresAt} />
    <div className="connection-qr-steps">
      <ol>
        <li>Abra o WhatsApp no celular{phone ? <> do número <strong>{phone}</strong></> : null}.</li>
        <li>Toque em <strong>Mais opções ⋮</strong> ou <strong>Configurações</strong> e depois em <strong>Aparelhos conectados</strong>.</li>
        <li>Toque em <strong>Conectar aparelho</strong> e aponte a câmera para este código.</li>
      </ol>
      <Countdown expiresAt={qr.qr.expiresAt} />
    </div>
  </div>;
}

function formatPhone(value: string | null | undefined) {
  const digits = value?.replace(/\D/g, '') ?? '';
  const match = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return match ? `+55 (${match[1]}) ${match[2]}-${match[3]}` : digits ? `+${digits}` : null;
}

export function ChannelConnectionsPanel({ channel, primaryQr, qrEvent, getToken, onChannel, onPrimaryQr }: { channel: ChannelDto; primaryQr: ChannelQrResultDto | null; qrEvent: QrEvent | null; getToken: () => Promise<string | null>; onChannel: (channel: ChannelDto) => void; onPrimaryQr: () => void }) {
  const [secondaryQr, setSecondaryQr] = useState<ChannelQrResultDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [linked, setLinked] = useState<string | null>(null);
  const [hiddenPrimaryQr, setHiddenPrimaryQr] = useState<string | null>(null);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const requested = useRef(false);
  const retryUntil = useRef(0);
  const latest = useRef(channel);
  const qrRef = useRef(secondaryQr);
  const previousStatus = useRef<Record<string, string>>({});
  latest.current = channel; qrRef.current = secondaryQr;
  useEffect(() => () => { generation.current++; }, [channel.id]);
  useEffect(() => { if (qrEvent) setSecondaryQr((current) => applyQrUpdate(current, qrEvent.payload)); }, [qrEvent]);
  // When a connection comes up, its QR has done its job: it disappears and a short confirmation takes its place.
  useEffect(() => {
    for (const entry of connectionDisplay(channel)) {
      const before = previousStatus.current[entry.provider];
      if (before && before !== 'connected' && entry.status === 'connected') {
        setLinked(entry.provider);
        if (entry.provider === 'evolution' && primaryQr) setHiddenPrimaryQr(qrKey(primaryQr));
      }
      previousStatus.current[entry.provider] = entry.status;
    }
  }, [channel, primaryQr]);
  useEffect(() => { if (!linked) return; const timer = window.setTimeout(() => setLinked(null), 6_000); return () => window.clearTimeout(timer); }, [linked]);
  const accept = useCallback((result: ChannelQrResultDto, request: number) => {
    if (generation.current !== request || result.channel.id !== latest.current.id || result.provider !== 'waha' || result.connectionId !== latest.current.connections?.find((c) => c.provider === 'waha')?.id || Date.parse(result.qr.expiresAt) <= Date.now()) return;
    setSecondaryQr((current) => current && Date.parse(current.qr.issuedAt ?? '') > Date.parse(result.qr.issuedAt ?? '') ? current : result);
    onChannel(result.channel);
  }, [onChannel]);
  const generateSecondary = useCallback(async (automatic = false) => {
    if (busyRef.current) return;
    if (automatic && Date.now() >= retryUntil.current) {
      requested.current = false;
      setNotice('A conexão reserva demorou para iniciar. Gere o QR novamente para tentar de novo.');
      return;
    }
    if (!automatic) retryUntil.current = Date.now() + 60_000;
    busyRef.current = true; setBusy(true); setNotice(null); requested.current = true;
    const request = ++generation.current;
    try {
      let current = latest.current;
      if (!current.redundancyEnabled) {
        const enabled = await apiSetChannelRedundancy(getToken, current.id, true);
        if (generation.current !== request) return;
        current = enabled.channel; latest.current = current; onChannel(current);
      }
      const connection = current.connections?.find((c) => c.provider === 'waha');
      if (!connection) throw new Error('A conexão reserva não foi criada neste canal.');
      accept(await apiStartConnectionQr(getToken, current.id, connection.id), request);
    } catch (error) { if (generation.current === request) setNotice(error instanceof Error ? error.message : 'Não foi possível gerar o QR da conexão reserva.'); }
    finally { busyRef.current = false; if (generation.current === request) setBusy(false); }
  }, [getToken, onChannel, accept]);
  useEffect(() => {
    let cancelled = false; let polling = false;
    const timer = window.setInterval(() => {
      if (polling || busyRef.current) return;
      polling = true;
      void (async () => {
        const current = latest.current;
        const connections = current.connections ?? [];
        for (const connection of connections) {
          if (connection.provider === 'waha' && !current.redundancyEnabled) continue;
          try {
            const state = await apiGetConnectionState(getToken, current.id, connection.id);
            if (cancelled) return;
            latest.current = state.channel; onChannel(state.channel);
          } catch { /* Keep the last observed state; the service persists probe failures. */ }
        }
        const secondary = latest.current.connections?.find((c) => c.provider === 'waha');
        if (secondary?.status === 'connected') { requested.current = false; setSecondaryQr(null); }
        else if (!cancelled && requested.current && (!qrRef.current || Date.parse(qrRef.current.qr.expiresAt) <= Date.now() + 5_000)) await generateSecondary(true);
      })().finally(() => { polling = false; });
    }, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [channel.id, getToken, onChannel, generateSecondary]);
  async function secondaryAction(disable: boolean) {
    if (busyRef.current) return;
    const secondary = latest.current.connections?.find((c) => c.provider === 'waha');
    if (!secondary) return;
    generation.current++; requested.current = false; busyRef.current = true; setBusy(true); setNotice(null);
    try {
      const result = disable ? await apiSetChannelRedundancy(getToken, channel.id, false) : await apiDisconnectConnection(getToken, channel.id, secondary.id);
      setSecondaryQr(null); onChannel(result.channel);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Não foi possível desconectar a conexão reserva.'); }
    finally { busyRef.current = false; setBusy(false); }
  }

  const summary = connectionSummary(channel);
  const phone = formatPhone(channel.phoneNumber ?? channel.connections?.find((c) => c.verifiedPhoneNumber)?.verifiedPhoneNumber);
  const SummaryIcon = summary.tone === 'ok' ? CheckCircle2 : summary.tone === 'down' ? WifiOff : TriangleAlert;
  const bothConnected = channel.connections?.filter((c) => c.status === 'connected').length === 2;
  return <div className="channel-connections-panel">
    <section className={`connections-summary is-${summary.tone}`} aria-live="polite">
      <SummaryIcon size={22} aria-hidden="true" />
      <div>
        <strong>{summary.title}</strong>
        <p>{summary.detail}</p>
        <small>{summary.count}{phone ? <> · <Smartphone size={12} aria-hidden="true" /> {phone}</> : null}</small>
      </div>
    </section>

    {connectionDisplay(channel).map((entry) => {
      const { provider, label, connection, status, isActiveWriter } = entry;
      const isPrimary = provider === 'evolution';
      const enabled = isPrimary || channel.redundancyEnabled;
      const qr = isPrimary ? (primaryQr && qrKey(primaryQr) !== hiddenPrimaryQr ? primaryQr : null) : secondaryQr;
      const issue = enabled ? problem(entry) : null;
      const stateLabel = !enabled ? 'Desligada' : status === 'connected' ? (entry.health === 'degraded' ? 'Conectada · instável' : entry.health === 'unhealthy' ? 'Conectada · sem resposta' : 'Conectada')
        : status === 'connecting' ? 'Conectando…' : status === 'failed' ? 'Falhou' : 'Desconectada';
      const tone = !enabled ? 'off' : status === 'connected' ? (entry.health === 'degraded' || entry.health === 'unhealthy' ? 'warning' : 'ok') : status === 'connecting' ? 'pending' : 'down';
      return <section key={provider} className={`connection-card is-${tone}`} aria-label={`Conexão ${label}`} data-connection-id={connection?.id}>
        <header className="connection-card-head">
          <div>
            <h3>{isPrimary ? 'Conexão principal' : 'Conexão reserva'} <span className="connection-engine">{label}</span></h3>
            <p className="connection-card-hint">{isPrimary ? 'Recebe e envia as mensagens deste número.' : 'Segunda conexão do mesmo número: assume se a principal cair.'}</p>
          </div>
          <span className={`connection-state is-${tone}`}><i aria-hidden="true" />{stateLabel}</span>
        </header>
        {isActiveWriter && status === 'connected' ? <p className="connection-writer"><Send size={13} aria-hidden="true" /> Enviando mensagens por esta conexão</p> : null}
        {linked === provider ? <p className="connection-callout is-ok" role="status"><CheckCircle2 size={15} aria-hidden="true" /> Conectado! Pode fechar esta janela.</p> : null}
        {issue ? <p className={`connection-callout is-${issue.tone}`}><CircleAlert size={15} aria-hidden="true" /> {issue.text}</p> : null}
        {!isPrimary && notice ? <p className="connection-callout is-error" role="status"><CircleAlert size={15} aria-hidden="true" /> {notice}</p> : null}
        {qr ? <QrStep provider={label} qr={qr} phone={phone} /> : null}
        {isPrimary ? <div className="connection-actions">
          <button className={status === 'connected' && !qr ? 'secondary-button' : 'primary-button'} type="button" onClick={onPrimaryQr}>
            <QrCode size={15} aria-hidden="true" />{qr ? 'Gerar outro QR Code' : status === 'connected' ? 'Reconectar com QR Code' : 'Gerar QR Code'}
          </button>
        </div> : channel.redundancyAvailable === false ? <p className="connection-card-hint">A conexão reserva ainda não está liberada para este canal.</p> : <div className="connection-actions">
          {status !== 'connected' || qr ? <button className={qr ? 'secondary-button' : 'primary-button'} type="button" disabled={busy} onClick={() => void generateSecondary()}>
            {busy ? <LoaderCircle className="connection-spin" size={15} aria-hidden="true" /> : <QrCode size={15} aria-hidden="true" />}
            {qr ? 'Gerar outro QR Code da reserva' : channel.redundancyEnabled ? 'Gerar QR Code da reserva' : 'Ativar conexão reserva'}
          </button> : null}
          {channel.redundancyEnabled ? <>
            {status === 'connected' || status === 'connecting' ? <button className="text-button" type="button" disabled={busy} onClick={() => void secondaryAction(false)}>Desconectar reserva</button> : null}
            <button className="text-button" type="button" disabled={busy} onClick={() => void secondaryAction(true)}>Desligar reserva</button>
          </> : null}
        </div>}
      </section>;
    })}

    {bothConnected ? <details className="connections-diagnostics">
      <summary>Diagnóstico avançado</summary>
      <HistoryComparisonPanel channelId={channel.id} getToken={getToken} />
    </details> : null}
  </div>;
}
