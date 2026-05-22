import { useTalkAuth } from "../../app/auth";
import type { ChannelDto, ChannelQrResultDto, RealtimeEvent } from "@prymeira-talk/shared";
import { CheckCircle2, Link2, MessageCircle, PlugZap, QrCode, RefreshCw, Trash2, WifiOff } from "lucide-react";
import QRCode from "qrcode";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiCreateChannel,
  apiCreateTestInbound,
  apiDeleteChannel,
  apiDisconnectChannel,
  apiGetChannels,
  apiStartChannelQr
} from "../../app/api";
import { useRealtimeEvents } from "../inbox/useRealtimeEvents";
import { getQrDisplaySource } from "./qr-display";

const statusLabels: Record<ChannelDto["status"], string> = {
  disconnected: "Desconectado",
  connecting: "Conectando",
  connected: "Conectado",
  failed: "Falhou"
};

const publicWebhookUrl = "https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace";
const localWebhookUrl = "http://localhost:3002/webhooks/evolution/local_workspace";

function channelTitle(channel: ChannelDto) {
  return channel.displayName ?? channel.phoneNumber ?? channel.providerKey;
}

function mergeChannel(channels: ChannelDto[], channel: ChannelDto) {
  const withoutChannel = channels.filter((current) => current.id !== channel.id);
  return [channel, ...withoutChannel];
}

function filterDeletedChannels(channels: ChannelDto[], deletedChannelIds: Set<string>) {
  return channels.filter((channel) => !deletedChannelIds.has(channel.id));
}

function getSelectedChannelIdAfterDelete(
  channels: ChannelDto[],
  deletedChannelId: string,
  selectedChannelId: string | null
) {
  if (selectedChannelId !== deletedChannelId && channels.some((channel) => channel.id === selectedChannelId)) {
    return selectedChannelId;
  }

  const deletedIndex = channels.findIndex((channel) => channel.id === deletedChannelId);
  const remainingChannels = channels.filter((channel) => channel.id !== deletedChannelId);

  if (remainingChannels.length === 0) {
    return null;
  }

  if (deletedIndex >= 0 && deletedIndex < remainingChannels.length) {
    return remainingChannels[deletedIndex].id;
  }

  return remainingChannels[remainingChannels.length - 1]?.id ?? null;
}

export function ChannelsPage() {
  const { getToken } = useTalkAuth();
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [qrResult, setQrResult] = useState<ChannelQrResultDto | null>(null);
  const [deletedChannelIds, setDeletedChannelIds] = useState<Set<string>>(() => new Set());
  const channelsRef = useRef<ChannelDto[]>([]);
  const deletedChannelIdsRef = useRef(deletedChannelIds);
  const qrChannelIdRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [realtimeToken, setRealtimeToken] = useState<string | null>(null);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [qrDrawerOpen, setQrDrawerOpen] = useState(false);
  const [generatedQrImageSrc, setGeneratedQrImageSrc] = useState<string | null>(null);
  const [qrRenderError, setQrRenderError] = useState<string | null>(null);

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

        const availableChannels = filterDeletedChannels(nextChannels, deletedChannelIdsRef.current);

        setChannels(availableChannels);
        setSelectedChannelId((current) =>
          availableChannels.some((channel) => channel.id === current)
            ? current
            : availableChannels[0]?.id ?? null
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

  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  useEffect(() => {
    deletedChannelIdsRef.current = deletedChannelIds;
  }, [deletedChannelIds]);

  useEffect(() => {
    qrChannelIdRef.current = qrResult?.channel.id ?? null;
  }, [qrResult?.channel.id]);

  const markChannelDeleted = useCallback((channelId: string) => {
    setDeletedChannelIds((current) => {
      const next = new Set(current);
      next.add(channelId);
      deletedChannelIdsRef.current = next;
      return next;
    });
  }, []);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    if (event.type === "channel.qr_updated") {
      setQrResult((current) =>
        current?.channel.id === event.payload.channelId
          ? {
              ...current,
              mode: "real",
              qrCode: event.payload.qrCode,
              qr: {
                payload: event.payload.qrCode,
                expiresAt: event.payload.expiresAt
              }
            }
          : current
      );
      return;
    }

    if (event.type === "channel.deleted") {
      const { channelId } = event.payload;

      markChannelDeleted(channelId);
      setChannels((current) => current.filter((channel) => channel.id !== channelId));
      setSelectedChannelId((selected) => getSelectedChannelIdAfterDelete(channelsRef.current, channelId, selected));
      setQrResult((current) => {
        if (current?.channel.id === channelId) {
          return null;
        }

        return current;
      });
      if (qrChannelIdRef.current === channelId) {
        setQrDrawerOpen(false);
      }
      return;
    }

    if (event.type !== "channel.updated") return;
    if (deletedChannelIdsRef.current.has(event.payload.id)) return;

    setChannels((current) => mergeChannel(current, event.payload));
    setSelectedChannelId((current) => current ?? event.payload.id);
    setQrResult((current) =>
      current?.channel.id === event.payload.id
        ? { ...current, channel: event.payload }
        : current
    );
  }, [markChannelDeleted]);

  useRealtimeEvents({
    token: realtimeToken,
    onEvent: handleRealtimeEvent
  });

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId) ?? null,
    [channels, selectedChannelId]
  );
  const qrDisplaySource = useMemo(() => getQrDisplaySource(qrResult?.qrCode), [qrResult?.qrCode]);
  const qrPayload = qrDisplaySource?.kind === "payload" ? qrDisplaySource.payload : null;

  useEffect(() => {
    let isCancelled = false;

    setQrRenderError(null);

    if (!qrPayload) {
      setGeneratedQrImageSrc(null);
      return () => {
        isCancelled = true;
      };
    }

    setGeneratedQrImageSrc(null);

    void QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: "M",
      margin: 3,
      scale: 9,
      color: {
        dark: "#13291f",
        light: "#ffffff"
      }
    })
      .then((dataUrl) => {
        if (!isCancelled) {
          setGeneratedQrImageSrc(dataUrl);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setQrRenderError("Nao foi possivel renderizar o QR recebido.");
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [qrPayload]);

  const simulatedModeActive = qrResult?.mode === "simulated";
  const qrImageSrc = qrDisplaySource?.kind === "image" ? qrDisplaySource.src : generatedQrImageSrc;
  const connectedCount = channels.filter((channel) => channel.status === "connected").length;
  const connectingCount = channels.filter((channel) => channel.status === "connecting").length;

  async function createChannelAndStartQr(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const displayName = newChannelName.trim();
    if (!displayName) {
      setError("Informe um nome para o canal.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);
    setQrResult(null);
    setQrDrawerOpen(false);

    try {
      const channel = await apiCreateChannel(getToken, { displayName });
      if (deletedChannelIdsRef.current.has(channel.id)) {
        return;
      }

      setChannels((current) => mergeChannel(current, channel));
      setSelectedChannelId(channel.id);

      const result = await apiStartChannelQr(getToken, channel.id);
      if (deletedChannelIdsRef.current.has(result.channel.id)) {
        return;
      }

      setQrResult(result);
      setChannels((current) => mergeChannel(current, result.channel));
      setCreateDrawerOpen(false);
      setNewChannelName("");
      setQrDrawerOpen(true);
      setNotice("Sessao QR iniciada.");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Nao foi possivel criar o canal.");
    } finally {
      setIsSaving(false);
    }
  }

  async function reconnectChannel(channel: ChannelDto) {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    setSelectedChannelId(channel.id);
    setQrResult(null);
    setQrDrawerOpen(false);

    try {
      const result = await apiStartChannelQr(getToken, channel.id);
      if (deletedChannelIdsRef.current.has(result.channel.id)) {
        return;
      }

      setQrResult(result);
      setChannels((current) => mergeChannel(current, result.channel));
      setQrDrawerOpen(true);
      setNotice("QR de reconexao iniciado.");
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
      if (deletedChannelIdsRef.current.has(result.channel.id)) {
        return;
      }

      setChannels((current) => mergeChannel(current, result.channel));
      setQrResult((current) => (current?.channel.id === channel.id ? null : current));
      setNotice("Canal desconectado.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao desconectar.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteChannel(channel: ChannelDto) {
    const confirmed = window.confirm(`Apagar o canal "${channelTitle(channel)}"? Esta acao remove as conversas ligadas a este canal.`);
    if (!confirmed) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      await apiDeleteChannel(getToken, channel.id);
      markChannelDeleted(channel.id);
      setChannels((current) => current.filter((item) => item.id !== channel.id));
      setSelectedChannelId((selected) => getSelectedChannelIdAfterDelete(channelsRef.current, channel.id, selected));
      setQrResult((current) => {
        if (current?.channel.id === channel.id) {
          return null;
        }

        return current;
      });
      if (qrChannelIdRef.current === channel.id) {
        setQrDrawerOpen(false);
      }
      setNotice("Canal apagado.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao apagar canal.");
    } finally {
      setIsSaving(false);
    }
  }

  async function testInbound() {
    if (!selectedChannel) {
      setError("Selecione um canal para enviar mensagem de teste.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const result = await apiCreateTestInbound(getToken, selectedChannel.id);
      if (deletedChannelIdsRef.current.has(result.channel.id)) {
        return;
      }

      setChannels((current) => mergeChannel(current, result.channel));
      setSelectedChannelId(result.channel.id);
      setNotice("Mensagem inbound de teste enviada para a fila.");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Nao foi possivel atualizar o canal.");
    } finally {
      setIsSaving(false);
    }
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
          onClick={() => {
            setCreateDrawerOpen(true);
            setError(null);
            setNotice(null);
          }}
          type="button"
        >
          <QrCode size={16} aria-hidden="true" />
          Novo canal
        </button>
      </header>

      {error ? <p className="error-note" style={{ margin: '0 16px' }}>{error}</p> : null}
      {notice ? <p className="list-note" style={{ margin: '0 16px' }}>{notice}</p> : null}

      <div className="channel-technical-strip">
        <span className="status-badge status-badge--bot">
          Evolution {qrResult?.mode === "real" ? "Real" : "Simulado"}
        </span>
        <code>{publicWebhookUrl}</code>
        <code>{localWebhookUrl}</code>
      </div>

      <div className="channels-list-wrap">
        {isLoading ? (
          <p className="list-note">Carregando canais...</p>
        ) : channels.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <PlugZap size={28} aria-hidden="true" />
            </div>
            <h3>Nenhum canal conectado</h3>
            <p>Clique em "Novo canal" para iniciar uma sessão Evolution conforme o modo ativo.</p>
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
                    {channel.phoneNumber ?? "Numero ainda nao identificado"}
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
                  <button
                    className="secondary-button danger-button"
                    disabled={isSaving}
                    onClick={() => { void deleteChannel(channel); }}
                    type="button"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Apagar
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {createDrawerOpen ? (
        <>
          <div
            className="contact-drawer-overlay"
            onClick={() => setCreateDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside className="contact-drawer is-open" aria-label="Novo canal WhatsApp">
            <header className="contact-drawer-header">
              <span className="context-card-title">Novo canal</span>
              <button
                className="drawer-close"
                onClick={() => setCreateDrawerOpen(false)}
                type="button"
                aria-label="Fechar"
              >
                ✕
              </button>
            </header>
            <form className="contact-drawer-body" onSubmit={createChannelAndStartQr}>
              <div className="context-card">
                <label className="field-label" htmlFor="channel-name">Nome do canal</label>
                <input
                  className="text-input"
                  id="channel-name"
                  maxLength={160}
                  name="channelName"
                  autoComplete="organization-title"
                  onChange={(event) => setNewChannelName(event.target.value)}
                  placeholder="Comercial, Suporte, Cliente Ana..."
                  value={newChannelName}
                />
              </div>
              <button className="primary-button" disabled={isSaving || !newChannelName.trim()} type="submit">
                <QrCode size={16} aria-hidden="true" />
                Gerar QR
              </button>
            </form>
          </aside>
        </>
      ) : null}

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
                  {qrImageSrc ? (
                    <img
                      alt="QR Code para conectar o WhatsApp"
                      className="qr-image"
                      src={qrImageSrc}
                    />
                  ) : qrPayload ? (
                    <>
                      <QrCode size={36} aria-hidden="true" />
                      <span className="qr-status-note">
                        {qrRenderError ?? 'Gerando QR visivel...'}
                      </span>
                    </>
                  ) : (
                    <>
                      <QrCode size={36} aria-hidden="true" />
                      <code>{qrResult?.qrCode ?? 'Gerando sessão QR...'}</code>
                    </>
                  )}
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
                    <span>{selectedChannel ? 'Canal selecionado' : 'Selecione um canal'}</span>
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
