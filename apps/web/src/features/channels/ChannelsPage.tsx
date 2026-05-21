import { useAuth } from "@clerk/clerk-react";
import type { ChannelDto, ChannelQrResultDto, RealtimeEvent } from "@prymeira-talk/shared";
import { CheckCircle2, Link2, MessageCircle, PlugZap, QrCode, RefreshCw, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiCreateChannel,
  apiCreateTestInbound,
  apiDisconnectChannel,
  apiGetChannels,
  apiReconnectChannel,
  apiStartChannelQr
} from "../../app/api";
import { useRealtimeEvents } from "../inbox/useRealtimeEvents";

const statusLabels: Record<ChannelDto["status"], string> = {
  disconnected: "Desconectado",
  connecting: "Conectando",
  connected: "Conectado",
  failed: "Falhou"
};

function channelTitle(channel: ChannelDto) {
  return channel.displayName ?? channel.phoneNumber ?? channel.providerKey;
}

function mergeChannel(channels: ChannelDto[], channel: ChannelDto) {
  const withoutChannel = channels.filter((current) => current.id !== channel.id);
  return [channel, ...withoutChannel];
}

export function ChannelsPage() {
  const { getToken } = useAuth();
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [qrResult, setQrResult] = useState<ChannelQrResultDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [realtimeToken, setRealtimeToken] = useState<string | null>(null);
  const [qrDrawerOpen, setQrDrawerOpen] = useState(false);

  useEffect(() => {
    let isMounted = true;

    void getToken()
      .then((token) => {
        if (isMounted) {
          setRealtimeToken(token);
        }
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
    };
  }, [getToken]);

  useEffect(() => {
    let isMounted = true;

    async function loadChannels() {
      setIsLoading(true);
      setError(null);

      try {
        const nextChannels = await apiGetChannels(getToken);

        if (!isMounted) return;

        setChannels(nextChannels);
        setSelectedChannelId((current) =>
          nextChannels.some((channel) => channel.id === current)
            ? current
            : nextChannels[0]?.id ?? null
        );
      } catch (loadError) {
        if (!isMounted) return;
        setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar canais.");
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadChannels();

    return () => {
      isMounted = false;
    };
  }, [getToken]);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    if (event.type !== "channel.updated") return;

    setChannels((current) => mergeChannel(current, event.payload));
    setSelectedChannelId((current) => current ?? event.payload.id);
    setQrResult((current) =>
      current?.channel.id === event.payload.id
        ? { ...current, channel: event.payload }
        : current
    );
  }, []);

  useRealtimeEvents({
    token: realtimeToken,
    onEvent: handleRealtimeEvent
  });

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId) ?? null,
    [channels, selectedChannelId]
  );
  const simulatedModeActive = qrResult?.mode === "simulated";
  const connectedCount = channels.filter((channel) => channel.status === "connected").length;
  const connectingCount = channels.filter((channel) => channel.status === "connecting").length;

  async function ensureChannel() {
    if (selectedChannel) {
      return selectedChannel;
    }

    const channel = await apiCreateChannel(getToken, {
      displayName: "WhatsApp Demo",
      providerKey: "demo-evolution",
      phoneNumber: "+55 47 99999-0000"
    });
    setChannels((current) => mergeChannel(current, channel));
    setSelectedChannelId(channel.id);
    return channel;
  }

  async function runChannelAction(
    action: (channel: ChannelDto) => Promise<ChannelDto>,
    successMessage: string
  ) {
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const channel = await ensureChannel();
      const updatedChannel = await action(channel);
      setChannels((current) => mergeChannel(current, updatedChannel));
      setSelectedChannelId(updatedChannel.id);
      setNotice(successMessage);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Nao foi possivel atualizar o canal.");
    } finally {
      setIsSaving(false);
    }
  }

  async function startQr() {
    setQrDrawerOpen(true);
    await runChannelAction(async (channel) => {
      const result = await apiStartChannelQr(getToken, channel.id);
      setQrResult(result);
      return result.channel;
    }, "Sessao QR iniciada.");
  }

  async function reconnectChannel(channel: ChannelDto) {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiReconnectChannel(getToken, channel.id);
      setChannels((current) => mergeChannel(current, result.channel));
      setNotice("Reconexao solicitada.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao reconectar.");
    } finally {
      setIsSaving(false);
    }
  }

  async function disconnectChannel(channel: ChannelDto) {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiDisconnectChannel(getToken, channel.id);
      setChannels((current) => mergeChannel(current, result.channel));
      setQrResult((current) => (current?.channel.id === channel.id ? null : current));
      setNotice("Canal desconectado.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao desconectar.");
    } finally {
      setIsSaving(false);
    }
  }

  async function testInbound() {
    await runChannelAction(async (channel) => {
      const result = await apiCreateTestInbound(getToken, channel.id);
      return result.channel;
    }, "Mensagem inbound de teste enviada para a fila.");
  }

  return (
    <section className="module-page" aria-label="Canais">
      <header className="module-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div>
            <p className="eyebrow">Prymeira Talk</p>
            <h1>Canais</h1>
          </div>
          <div className="channels-health-chips" aria-label="Status dos canais">
            <span className="status-badge status-badge--open">
              {connectedCount} conectado{connectedCount !== 1 ? 's' : ''}
            </span>
            {connectingCount > 0 ? (
              <span className="status-badge status-badge--waiting">
                {connectingCount} conectando
              </span>
            ) : null}
          </div>
        </div>
        <button
          className="primary-button"
          disabled={isSaving}
          onClick={() => { void startQr(); }}
          type="button"
        >
          <QrCode size={16} aria-hidden="true" />
          Conectar canal
        </button>
      </header>

      {error ? <p className="error-note" style={{ margin: '0 16px' }}>{error}</p> : null}
      {notice ? <p className="list-note" style={{ margin: '0 16px' }}>{notice}</p> : null}

      <div className="channels-list-wrap">
        {isLoading ? (
          <p className="list-note">Carregando canais...</p>
        ) : channels.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <PlugZap size={28} aria-hidden="true" />
            </div>
            <h3>Nenhum canal conectado</h3>
            <p>Clique em "Conectar canal" para criar uma sessão demo com QR simulado.</p>
          </div>
        ) : (
          <div className="channel-card-list" role="list">
            {channels.map((channel) => (
              <article
                className={`channel-row-card ${channel.id === selectedChannelId ? 'is-selected' : ''}`}
                key={channel.id}
                role="listitem"
              >
                <button
                  className="channel-row-main"
                  onClick={() => {
                    setSelectedChannelId(channel.id);
                    setQrResult((current) => (current?.channel.id === channel.id ? current : null));
                  }}
                  type="button"
                >
                  <span className={`status-badge status-badge--${channel.status === 'connected' ? 'open' : channel.status === 'connecting' ? 'waiting' : 'closed'}`}>
                    {statusLabels[channel.status]}
                  </span>
                  <span className="channel-row-info">
                    <strong>{channelTitle(channel)}</strong>
                    <small>{channel.provider === 'evolution' ? 'Evolution API' : channel.provider}</small>
                  </span>
                  <span className="channel-row-phone">
                    {channel.phoneNumber ?? channel.providerKey}
                  </span>
                </button>
                <div className="channel-row-actions">
                  <button
                    className="secondary-button"
                    disabled={isSaving}
                    onClick={() => { void reconnectChannel(channel); }}
                    type="button"
                  >
                    <RefreshCw size={14} aria-hidden="true" />
                    Reconectar
                  </button>
                  <button
                    className="secondary-button"
                    disabled={isSaving}
                    onClick={() => { void disconnectChannel(channel); }}
                    type="button"
                  >
                    <WifiOff size={14} aria-hidden="true" />
                    Desconectar
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* QR Drawer */}
      {qrDrawerOpen ? (
        <>
          <div
            className="contact-drawer-overlay"
            onClick={() => setQrDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside className="contact-drawer is-open" aria-label="Conectar canal via QR">
            <header className="contact-drawer-header">
              <span className="context-card-title">Conectar via QR</span>
              <button
                className="drawer-close"
                onClick={() => setQrDrawerOpen(false)}
                type="button"
                aria-label="Fechar"
              >
                ✕
              </button>
            </header>
            <div className="contact-drawer-body">
              <div className="context-card">
                <div className="context-card-title">Payload QR</div>
                <div className="qr-box" aria-label="Payload do QR Code">
                  <QrCode size={36} aria-hidden="true" />
                  <code>{qrResult?.qrCode ?? 'Gerando sessão QR...'}</code>
                </div>
              </div>
              <div className="context-card">
                <div className="context-card-title">Checklist</div>
                <div className="setup-checklist" aria-label="Checklist de setup">
                  <div>
                    <CheckCircle2 size={16} aria-hidden="true" />
                    <span>Workspace autenticado</span>
                  </div>
                  <div>
                    <CheckCircle2 size={16} aria-hidden="true" />
                    <span>{selectedChannel ? 'Canal selecionado' : 'Canal será criado automaticamente'}</span>
                  </div>
                  <div>
                    <Link2 size={16} aria-hidden="true" />
                    <span>{qrResult ? 'Sessão QR pronta — escaneie o QR no WhatsApp' : 'Iniciando sessão QR...'}</span>
                  </div>
                </div>
              </div>
              {simulatedModeActive ? (
                <div className="context-card">
                  <div className="context-card-title">Modo simulado ativo</div>
                  <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', margin: 0 }}>
                    Este canal está em modo simulado — mensagens de teste são aceitas sem WhatsApp real.
                  </p>
                  <button
                    className="secondary-button"
                    disabled={isSaving}
                    onClick={() => void testInbound()}
                    type="button"
                    style={{ marginTop: '4px' }}
                  >
                    <MessageCircle size={14} aria-hidden="true" />
                    Enviar mensagem de teste
                  </button>
                </div>
              ) : null}
            </div>
          </aside>
        </>
      ) : null}
    </section>
  );
}
