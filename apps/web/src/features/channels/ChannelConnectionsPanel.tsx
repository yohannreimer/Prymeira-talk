import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChannelDto, ChannelQrResultDto, RealtimeEvent } from '@prymeira-talk/shared';
import { apiDisconnectConnection, apiGetConnectionState, apiSetChannelRedundancy, apiStartConnectionQr } from '../../app/api';
import { ChannelQrView } from './ChannelQrView';
import { applyQrUpdate, connectionCount, connectionDisplay, qrKey } from './connection-display';

type QrEvent = Extract<RealtimeEvent, { type: 'channel.qr_updated' }>;
export function ChannelConnectionsPanel({ channel, primaryQr, qrEvent, getToken, onChannel, onPrimaryQr }: { channel: ChannelDto; primaryQr: ChannelQrResultDto | null; qrEvent: QrEvent | null; getToken: () => Promise<string | null>; onChannel: (channel: ChannelDto) => void; onPrimaryQr: () => void }) {
  const [secondaryQr, setSecondaryQr] = useState<ChannelQrResultDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const requested = useRef(false);
  const retryUntil = useRef(0);
  const latest = useRef(channel);
  const qrRef = useRef(secondaryQr);
  latest.current = channel; qrRef.current = secondaryQr;
  useEffect(() => () => { generation.current++; }, [channel.id]);
  useEffect(() => { if (qrEvent) setSecondaryQr((current) => applyQrUpdate(current, qrEvent.payload)); }, [qrEvent]);
  const accept = useCallback((result: ChannelQrResultDto, request: number) => {
    if (generation.current !== request || result.channel.id !== latest.current.id || result.provider !== 'waha' || result.connectionId !== latest.current.connections?.find((c) => c.provider === 'waha')?.id || Date.parse(result.qr.expiresAt) <= Date.now()) return;
    setSecondaryQr((current) => current && Date.parse(current.qr.issuedAt ?? '') > Date.parse(result.qr.issuedAt ?? '') ? current : result);
    onChannel(result.channel);
  }, [onChannel]);
  const generateSecondary = useCallback(async (automatic = false) => {
    if (busyRef.current) return;
    if (automatic && Date.now() >= retryUntil.current) {
      requested.current = false;
      setNotice('A inicialização demorou mais que o esperado. Gere o QR novamente para tentar conectar.');
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
      if (!connection) throw new Error('A conexão WAHA não foi criada neste canal.');
      accept(await apiStartConnectionQr(getToken, current.id, connection.id), request);
    } catch (error) { if (generation.current === request) setNotice(error instanceof Error ? error.message : 'Não foi possível gerar o QR WAHA.'); }
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
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Não foi possível desconectar WAHA.'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <div className="channel-connections-panel">
    <p className="status-badge" aria-live="polite">{connectionCount(channel)}</p>
    {connectionDisplay(channel).map(({ label: provider, connection, statusLabel, healthLabel, isActiveWriter }) => {
      const qr = provider === 'Evolution' ? primaryQr : secondaryQr;
      return <section key={provider} className="context-card" aria-label={`Conexão ${provider}`} data-connection-id={connection?.id}>
      <div className="context-card-title">{provider}</div>
      <p>{statusLabel} · {healthLabel}</p>
      {isActiveWriter ? <p>Enviando por esta conexão</p> : null}
      {connection?.lastError === 'PHONE_MISMATCH' ? <p className="error-note">Número diferente — conecte o mesmo número da Evolution. Esta conexão não pode enviar.</p> : null}
      {connection?.lastError === 'PRIMARY_PHONE_UNVERIFIED' ? <p>Confirme a conexão Evolution para verificar o número.</p> : null}
      {provider === 'Evolution' ? <>
        <ChannelQrView key={qr ? qrKey(qr) : `${channel.id}:${provider}`} provider={provider} qrCode={qr?.qrCode} expiresAt={qr?.qr.expiresAt} />
        <button className="secondary-button" type="button" onClick={onPrimaryQr}>Gerar QR Code — Evolution</button>
      </> : <>
        {qr ? <ChannelQrView key={qrKey(qr)} provider={provider} qrCode={qr.qrCode} expiresAt={qr.qr.expiresAt} /> : null}
        <button className="secondary-button" type="button" disabled={busy || channel.redundancyAvailable === false} onClick={() => void generateSecondary()}>{qr ? 'Atualizar QR Code — WAHA' : 'Gerar outro QR Code — WAHA'}</button>
        {channel.redundancyAvailable === false ? <p>WAHA estará disponível após qualificação.</p> : null}
        {channel.redundancyEnabled ? <div className="channel-row-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void secondaryAction(false)}>Desconectar WAHA</button>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void secondaryAction(true)}>Desativar redundância</button>
        </div> : null}
      </>}
    </section>; })}
    {notice ? <p className="error-note" role="status">{notice}</p> : null}
  </div>;
}
