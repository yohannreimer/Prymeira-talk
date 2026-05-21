import { useAuth } from "@clerk/clerk-react";
import type { ChannelDto, ChannelQrResultDto } from "@prymeira-talk/shared";
import { CheckCircle2, Link2, MessageCircle, PlugZap, QrCode, RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  apiCreateChannel,
  apiCreateTestInbound,
  apiDisconnectChannel,
  apiGetChannels,
  apiReconnectChannel,
  apiStartChannelQr
} from "../../app/api";

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
    await runChannelAction(async (channel) => {
      const result = await apiStartChannelQr(getToken, channel.id);
      setQrResult(result);
      return result.channel;
    }, "Sessao QR iniciada.");
  }

  async function reconnect() {
    await runChannelAction(async (channel) => {
      const result = await apiReconnectChannel(getToken, channel.id);
      return result.channel;
    }, "Reconexao solicitada.");
  }

  async function disconnect() {
    await runChannelAction(async (channel) => {
      const result = await apiDisconnectChannel(getToken, channel.id);
      setQrResult((current) => (current?.channel.id === channel.id ? null : current));
      return result.channel;
    }, "Canal desconectado.");
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
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Canais</h1>
        </div>
        <span className="status-pill status-pending">
          {simulatedModeActive ? "Modo simulado" : "Evolution API"}
        </span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button" onClick={startQr} disabled={isSaving}>
          <QrCode size={16} aria-hidden="true" />
          Conectar canal
        </button>
        <button className="secondary-button" type="button" onClick={reconnect} disabled={isSaving || !selectedChannel}>
          <RefreshCw size={16} aria-hidden="true" />
          Reconectar
        </button>
        <button className="secondary-button" type="button" onClick={disconnect} disabled={isSaving || !selectedChannel}>
          <WifiOff size={16} aria-hidden="true" />
          Desconectar
        </button>
        <button className="secondary-button" type="button" onClick={testInbound} disabled={isSaving || !selectedChannel}>
          <MessageCircle size={16} aria-hidden="true" />
          Teste inbound
        </button>
      </div>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="list-note">{notice}</p> : null}

      <div className="channels-grid">
        <div className="module-panel">
          <div className="panel-title-row">
            <h2>Conexoes</h2>
            <span>{isLoading ? "Carregando" : `${channels.length} canais`}</span>
          </div>

          <div className="channel-card-list">
            {channels.map((channel) => (
              <button
                className={`channel-card ${channel.id === selectedChannelId ? "is-selected" : ""}`}
                key={channel.id}
                type="button"
                onClick={() => {
                  setSelectedChannelId(channel.id);
                  setQrResult((current) => (current?.channel.id === channel.id ? current : null));
                }}
              >
                <span className={`status-pill status-${channel.status}`}>
                  {statusLabels[channel.status]}
                </span>
                <strong>{channelTitle(channel)}</strong>
                <small>{channel.provider === "evolution" ? "Evolution API" : channel.provider}</small>
                <em>{channel.phoneNumber ?? channel.providerKey}</em>
              </button>
            ))}

            {!isLoading && channels.length === 0 ? (
              <div className="channel-empty">
                <PlugZap size={22} aria-hidden="true" />
                <strong>Nenhum canal criado</strong>
                <span>Use Conectar canal para criar uma sessao demo com QR simulado.</span>
              </div>
            ) : null}
          </div>
        </div>

        <aside className="module-panel channel-qr-panel">
          <div className="panel-title-row">
            <h2>QR Code</h2>
            {simulatedModeActive ? <span>Modo simulado</span> : <span>Aguardando</span>}
          </div>

          <div className="qr-box" aria-label="Payload do QR Code">
            <QrCode size={42} aria-hidden="true" />
            <code>{qrResult?.qrCode ?? "Clique em Conectar canal para gerar o payload QR."}</code>
          </div>

          <div className="setup-checklist" aria-label="Checklist de setup">
            <div>
              <CheckCircle2 size={18} aria-hidden="true" />
              <span>Workspace autenticado</span>
            </div>
            <div>
              <CheckCircle2 size={18} aria-hidden="true" />
              <span>{selectedChannel ? "Canal selecionado" : "Criar canal demo"}</span>
            </div>
            <div>
              <Link2 size={18} aria-hidden="true" />
              <span>{qrResult ? "Sessao QR pronta" : "Iniciar sessao QR"}</span>
            </div>
          </div>

          <div className="channel-health-row">
            <div>
              <span>Conectados</span>
              <strong>{connectedCount}</strong>
            </div>
            <div>
              <span>Conectando</span>
              <strong>{connectingCount}</strong>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
