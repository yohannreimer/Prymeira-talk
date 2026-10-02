import { useTalkAuth } from "../../app/auth";
import type { ChannelDto, ChannelQrResultDto, RealtimeEvent } from "@prymeira-talk/shared";
import { Archive, ArchiveRestore, CheckCircle2, Link2, MessageCircle, PlugZap, QrCode, RefreshCw, Trash2, WifiOff } from "lucide-react";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiCreateChannel,
  apiCreateTestInbound,
  apiDeleteChannel,
  apiDisconnectChannel,
  apiGetChannelDeletionImpact,
  apiGetChannels,
  apiGetSettings,
  apiSetChannelArchived,
  apiStartChannelQr,
  type ChannelDeletionImpact,
  type SettingsDto
} from "../../app/api";
import { useRealtimeEvents } from "../inbox/useRealtimeEvents";
import { ChannelConnectionsPanel } from "./ChannelConnectionsPanel";
import { OutboundReviewPanel } from "./OutboundReviewPanel";
import { ConversationAuthorityPanel } from "./ConversationAuthorityPanel";
import { applyQrUpdate, connectionCount, connectionDisplay } from "./connection-display";
import { AssistantChannelSettings } from './AssistantChannelSettings';

const statusLabels: Record<ChannelDto["status"], string> = {
  disconnected: "Desconectado",
  connecting: "Conectando",
  connected: "Conectado",
  failed: "Falhou"
};

type CreateChannelProvider = "evolution" | "meta_cloud";

function channelTitle(channel: ChannelDto) {
  return channel.displayName ?? channel.phoneNumber ?? channel.providerKey;
}

function channelProviderLabel(channel: ChannelDto) {
  return channel.provider === "meta_cloud" ? "Meta oficial" : "Evolution API";
}

function asSettingsRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasStringSetting(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function getMetaCloudCreateSettings(settings: SettingsDto | null) {
  const integration = settings?.integrations.find((config) => config.provider === "meta_cloud");
  const integrationSettings = asSettingsRecord(integration?.settings);
  const connectionMode = integrationSettings.connectionMode === "evolution_official"
    ? "evolution_official"
    : "direct";
  const phoneNumberId = integrationSettings.phoneNumberId;
  const directEnabled = (
    integration?.mode === "real" &&
    integrationSettings.enabled === true &&
    hasStringSetting(integrationSettings.wabaId) &&
    hasStringSetting(phoneNumberId) &&
    hasStringSetting(integrationSettings.accessToken) &&
    hasStringSetting(integrationSettings.webhookVerifyToken) &&
    hasStringSetting(integrationSettings.appSecret)
  );
  const evolutionOfficialEnabled = (
    integration?.mode === "real" &&
    integrationSettings.enabled === true &&
    hasStringSetting(integrationSettings.evolutionBaseUrl) &&
    hasStringSetting(integrationSettings.evolutionApiKey)
  );

  return {
    enabled: connectionMode === "evolution_official" ? evolutionOfficialEnabled : directEnabled,
    connectionMode,
    providerKey: connectionMode === "evolution_official"
      ? ""
      : typeof phoneNumberId === "string" ? phoneNumberId : ""
  };
}

function mergeChannel(channels: ChannelDto[], channel: ChannelDto) {
  const withoutChannel = channels.filter((current) => current.id !== channel.id);
  const previous = channels.find((current) => current.id === channel.id);
  return [{ ...previous, ...channel }, ...withoutChannel];
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
  const primaryGeneration = useRef(0);
  const [qrEvent, setQrEvent] = useState<Extract<RealtimeEvent, { type: "channel.qr_updated" }> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [realtimeToken, setRealtimeToken] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ channel: ChannelDto; impact: ChannelDeletionImpact | null; typedName: string; error: string | null } | null>(null);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [createProvider, setCreateProvider] = useState<CreateChannelProvider>("evolution");
  const [newChannelName, setNewChannelName] = useState("");
  const [metaProviderKey, setMetaProviderKey] = useState("");
  const [metaPhoneNumber, setMetaPhoneNumber] = useState("");
  const [settings, setSettings] = useState<SettingsDto | null>(null);
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
        const nextChannels = await apiGetChannels(getToken, undefined, { includeArchived: true });

        if (!isMounted) return;

        const availableChannels = filterDeletedChannels(nextChannels, deletedChannelIdsRef.current);

        setChannels(availableChannels);
        setSelectedChannelId((current) =>
          availableChannels.some((channel) => channel.id === current)
            ? current
            : availableChannels[0]?.id ?? null
        );
        setIsLoading(false);

        const nextSettings = await apiGetSettings(getToken).catch(() => null);
        if (!isMounted) return;

        const metaSettings = getMetaCloudCreateSettings(nextSettings);

        setSettings(nextSettings);
        setMetaProviderKey((current) => current || metaSettings.providerKey);
      } catch (loadError) {
        if (!isMounted) return;
        setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar canais.");
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
    qrChannelIdRef.current = selectedChannelId;
  }, [selectedChannelId]);

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
      setQrEvent(event);
      setQrResult((current) => applyQrUpdate(current, event.payload));
      return;
    }

    if (event.type === "channel.deleted") {
      const { channelId } = event.payload;

      markChannelDeleted(channelId);
      if (qrChannelIdRef.current === channelId) primaryGeneration.current++;
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
        ? { ...current, channel: { ...current.channel, ...event.payload } }
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
  const updatePhysicalChannel = useCallback((channel: ChannelDto) => {
    if (deletedChannelIdsRef.current.has(channel.id)) return;
    setChannels((current) => mergeChannel(current, channel));
    setQrResult((current) => current?.channel.id === channel.id ? { ...current, channel: { ...current.channel, ...channel } } : current);
  }, []);
  const simulatedModeActive = qrResult?.mode === "simulated";
  const activeChannels = useMemo(() => channels.filter((channel) => !channel.archivedAt), [channels]);
  const archivedChannels = useMemo(() => channels.filter((channel) => channel.archivedAt), [channels]);
  const listedChannels = showArchived ? archivedChannels : activeChannels;
  const connectedCount = activeChannels.filter((channel) => channel.status === "connected").length;
  const connectingCount = activeChannels.filter((channel) => channel.status === "connecting").length;
  const metaCreateSettings = useMemo(() => getMetaCloudCreateSettings(settings), [settings]);

  useEffect(() => {
    if (!metaCreateSettings.enabled && createProvider === "meta_cloud") {
      setCreateProvider("evolution");
    }
  }, [createProvider, metaCreateSettings.enabled]);

  async function createChannel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const displayName = newChannelName.trim();
    if (!displayName) {
      setError("Informe um nome para o canal.");
      return;
    }

    if (createProvider === "meta_cloud" && !metaCreateSettings.enabled) {
      setError("A integração Meta Cloud não esta habilitada.");
      return;
    }

    const providerKey = metaProviderKey.trim();
    if (createProvider === "meta_cloud" && !providerKey) {
      setError(metaCreateSettings.connectionMode === "evolution_official"
        ? "Informe o Instance name da Evolution."
        : "Informe o Phone Number ID da Meta.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);
    setQrResult(null);
    setQrDrawerOpen(false);
    const request = ++primaryGeneration.current;

    try {
      if (createProvider === "meta_cloud") {
        const channel = await apiCreateChannel(getToken, {
          provider: "meta_cloud",
          displayName,
          providerKey,
          phoneNumber: metaPhoneNumber.trim() || undefined
        });
        if (deletedChannelIdsRef.current.has(channel.id)) {
          return;
        }

        setChannels((current) => mergeChannel(current, channel));
        setSelectedChannelId(channel.id);
        setCreateDrawerOpen(false);
        setNewChannelName("");
        setMetaPhoneNumber("");
        setNotice(channel.status === "failed"
          ? "Canal Meta oficial criado, mas o webhook não foi configurado na Evolution."
          : "Canal Meta oficial criado e webhook configurado.");
        return;
      }

      const channel = await apiCreateChannel(getToken, { displayName });
      if (deletedChannelIdsRef.current.has(channel.id)) {
        return;
      }

      setChannels((current) => mergeChannel(current, channel));
      setSelectedChannelId(channel.id);

      const result = await apiStartChannelQr(getToken, channel.id);
      if (primaryGeneration.current !== request || result.channel.id !== channel.id || deletedChannelIdsRef.current.has(result.channel.id) || Date.parse(result.qr.expiresAt) <= Date.now()) {
        return;
      }

      setQrResult(result);
      setChannels((current) => mergeChannel(current, result.channel));
      setCreateDrawerOpen(false);
      setNewChannelName("");
      setQrDrawerOpen(true);
      setNotice("Sessao QR iniciada.");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Não foi possível criar o canal.");
    } finally {
      setIsSaving(false);
    }
  }

  function closeQrDrawer() {
    primaryGeneration.current += 1;
    setQrDrawerOpen(false);
  }

  async function reconnectChannel(channel: ChannelDto) {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    setSelectedChannelId(channel.id);
    setQrResult(null);
    setQrDrawerOpen(true);
    const request = ++primaryGeneration.current;

    try {
      const result = await apiStartChannelQr(getToken, channel.id);
      if (primaryGeneration.current !== request || result.channel.id !== channel.id || deletedChannelIdsRef.current.has(result.channel.id) || Date.parse(result.qr.expiresAt) <= Date.now()) {
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

  async function setChannelArchived(channel: ChannelDto, archived: boolean) {
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const updated = await apiSetChannelArchived(getToken, channel.id, archived);
      setChannels((current) => mergeChannel(current, updated));
      setQrResult((current) => (current?.channel.id === channel.id ? null : current));
      setNotice(archived
        ? `Canal "${channelTitle(channel)}" arquivado. As conversas continuam no Atendimento.`
        : `Canal "${channelTitle(channel)}" restaurado. Reconecte para voltar a receber mensagens.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : archived ? "Erro ao arquivar canal." : "Erro ao restaurar canal.");
    } finally {
      setIsSaving(false);
    }
  }

  async function openDeleteDialog(channel: ChannelDto) {
    setError(null);
    setNotice(null);
    setDeleteTarget({ channel, impact: null, typedName: "", error: null });
    try {
      const impact = await apiGetChannelDeletionImpact(getToken, channel.id);
      setDeleteTarget((current) => (current?.channel.id === channel.id ? { ...current, impact } : current));
    } catch (err) {
      setDeleteTarget((current) => (current?.channel.id === channel.id
        ? { ...current, error: err instanceof Error ? err.message : "Não foi possível calcular o que será apagado." }
        : current));
    }
  }

  async function deleteChannel(channel: ChannelDto, confirmationName: string) {
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      await apiDeleteChannel(getToken, channel.id, confirmationName);
      setDeleteTarget(null);
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
      const message = err instanceof Error ? err.message : "Erro ao apagar canal.";
      setDeleteTarget((current) => (current?.channel.id === channel.id ? { ...current, error: message } : current));
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
      setError(actionError instanceof Error ? actionError.message : "Não foi possível atualizar o canal.");
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
            {archivedChannels.length > 0 || showArchived ? (
              <button className="secondary-button" onClick={() => setShowArchived((current) => !current)} type="button">
                {showArchived ? "Ver canais ativos" : `Arquivados (${archivedChannels.length})`}
              </button>
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
      <OutboundReviewPanel getToken={getToken} />
      <ConversationAuthorityPanel getToken={getToken} />

      <div className="channels-list-wrap">
        {isLoading ? (
          <p className="list-note">Carregando canais...</p>
        ) : showArchived && listedChannels.length === 0 ? (
          <p className="list-note">Nenhum canal arquivado.</p>
        ) : listedChannels.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <PlugZap size={28} aria-hidden="true" />
            </div>
            <h3>Nenhum canal conectado</h3>
            <p>Clique em "Novo canal" para iniciar uma sessão Evolution conforme o modo ativo.</p>
          </div>
        ) : (
          <div className="channel-card-list" role="list">
            {listedChannels.map((channel) => (
              <article
                className={`channel-row-card ${channel.id === selectedChannelId ? 'is-selected' : ''}`}
                key={channel.id}
                role="listitem"
              >
                <button
                  className="channel-row-main"
                  onClick={() => {
                    primaryGeneration.current++;
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
                    <small>{channelProviderLabel(channel)}</small>
                    {channel.provider === "evolution" ? <small>{connectionCount(channel)}</small> : null}
                    {channel.provider === 'evolution' ? <span className="channel-row-connections" aria-label="Conexões físicas">
                      {connectionDisplay(channel).map((connection) => <small key={connection.provider} data-provider={connection.provider} data-health={connection.health}>
                        {connection.label}: {connection.statusLabel} · {connection.healthLabel}
                        {connection.isActiveWriter ? <span className="channel-connection-writer"> · Envio ativo</span> : null}
                      </small>)}
                    </span> : null}
                  </span>
                  <span className="channel-row-phone">
                    {channel.phoneNumber ?? "Número ainda não identificado"}
                  </span>
                </button>
                <div className="channel-row-actions">
                  {channel.archivedAt ? (
                    <button
                      className="secondary-button"
                      disabled={isSaving}
                      onClick={() => { void setChannelArchived(channel, false); }}
                      type="button"
                    >
                      <ArchiveRestore size={14} aria-hidden="true" />
                      Restaurar
                    </button>
                  ) : null}
                  {!channel.archivedAt && channel.provider === "evolution" ? (
                    <>
                      <button className="secondary-button" type="button" onClick={() => {
                        primaryGeneration.current++;
                        setSelectedChannelId(channel.id);
                        setQrResult((current) => current?.channel.id === channel.id ? current : null);
                        setQrDrawerOpen(true);
                      }}>Conexões</button>
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
                    </>
                  ) : null}
                  {!channel.archivedAt ? (
                    <button
                      className="secondary-button"
                      disabled={isSaving}
                      onClick={() => { void setChannelArchived(channel, true); }}
                      title="Tira o canal da lista e mantém as conversas"
                      type="button"
                    >
                      <Archive size={14} aria-hidden="true" />
                      Arquivar
                    </button>
                  ) : null}
                  <button
                    className="secondary-button danger-button"
                    disabled={isSaving}
                    onClick={() => { void openDeleteDialog(channel); }}
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

      {deleteTarget ? (
        <div className="leads-dialog-backdrop" role="presentation">
          <section className="leads-dialog" role="dialog" aria-modal="true" aria-labelledby="channel-delete-title">
            <span className="leads-eyebrow">APAGAR CANAL</span>
            <h2 id="channel-delete-title">Apagar “{channelTitle(deleteTarget.channel)}” de vez?</h2>
            {deleteTarget.impact ? (
              <p>
                Isso apaga permanentemente <strong>{deleteTarget.impact.conversations} conversa{deleteTarget.impact.conversations === 1 ? "" : "s"}</strong> e{" "}
                <strong>{deleteTarget.impact.messages} mensage{deleteTarget.impact.messages === 1 ? "m" : "ns"}</strong> deste canal. Não dá para desfazer.
                Para só tirar o canal da lista e manter o histórico, use <strong>Arquivar</strong>.
              </p>
            ) : !deleteTarget.error ? <p>Calculando o que será apagado…</p> : null}
            {deleteTarget.impact ? (
              <label>
                Digite <strong>{deleteTarget.impact.confirmationName}</strong> para confirmar
                <input
                  aria-label="Nome do canal para confirmar"
                  autoFocus
                  className="text-input"
                  onChange={(event) => {
                    const typedName = event.target.value;
                    setDeleteTarget((current) => (current ? { ...current, typedName, error: null } : current));
                  }}
                  value={deleteTarget.typedName}
                />
              </label>
            ) : null}
            {deleteTarget.error ? <p className="leads-delete-error" role="alert">{deleteTarget.error}</p> : null}
            <div className="leads-dialog-actions">
              <button className="secondary-button" disabled={isSaving} onClick={() => setDeleteTarget(null)} type="button">Cancelar</button>
              {!deleteTarget.channel.archivedAt ? (
                <button
                  className="secondary-button"
                  disabled={isSaving}
                  onClick={() => { const { channel } = deleteTarget; setDeleteTarget(null); void setChannelArchived(channel, true); }}
                  type="button"
                >
                  Arquivar em vez disso
                </button>
              ) : null}
              <button
                className="leads-danger-button"
                disabled={isSaving || !deleteTarget.impact || deleteTarget.typedName.trim() !== deleteTarget.impact.confirmationName}
                onClick={() => { void deleteChannel(deleteTarget.channel, deleteTarget.typedName.trim()); }}
                type="button"
              >
                {isSaving ? "Apagando…" : "Apagar definitivamente"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {selectedChannelId ? <AssistantChannelSettings key={selectedChannelId} channelId={selectedChannelId} getToken={getToken} /> : null}
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
            <form className="contact-drawer-body" onSubmit={createChannel}>
              {metaCreateSettings.enabled ? (
                <div className="context-card">
                  <label className="field-label" htmlFor="channel-provider">Provider</label>
                  <select
                    className="text-input"
                    id="channel-provider"
                    name="channelProvider"
                    onChange={(event) => setCreateProvider(event.target.value as CreateChannelProvider)}
                    value={createProvider}
                  >
                    <option value="evolution">Evolution API</option>
                    <option value="meta_cloud">Meta oficial</option>
                  </select>
                </div>
              ) : null}
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
              {createProvider === "meta_cloud" ? (
                <>
                  <div className="context-card">
                    <label className="field-label" htmlFor="meta-provider-key">
                      {metaCreateSettings.connectionMode === "evolution_official" ? "Instance name" : "Phone Number ID"}
                    </label>
                    <input
                      className="text-input"
                      id="meta-provider-key"
                      maxLength={160}
                      name="metaProviderKey"
                      onChange={(event) => setMetaProviderKey(event.target.value)}
                      placeholder={metaCreateSettings.connectionMode === "evolution_official"
                        ? "instancia-oficial-na-evolution"
                        : "ID do número no WhatsApp Cloud API"}
                      value={metaProviderKey}
                    />
                  </div>
                  <div className="context-card">
                    <label className="field-label" htmlFor="meta-phone-number">Número exibido</label>
                    <input
                      className="text-input"
                      id="meta-phone-number"
                      maxLength={40}
                      name="metaPhoneNumber"
                      onChange={(event) => setMetaPhoneNumber(event.target.value)}
                      placeholder="+55 47 99999-0000"
                      value={metaPhoneNumber}
                    />
                  </div>
                </>
              ) : null}
              <button
                className="primary-button"
                disabled={
                  isSaving ||
                  !newChannelName.trim() ||
                  (createProvider === "meta_cloud" && !metaProviderKey.trim())
                }
                type="submit"
              >
                {createProvider === "meta_cloud" ? (
                  <PlugZap size={16} aria-hidden="true" />
                ) : (
                  <QrCode size={16} aria-hidden="true" />
                )}
                {createProvider === "meta_cloud" ? "Criar canal" : "Gerar QR"}
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
            onClick={closeQrDrawer}
            aria-hidden="true"
          />
          <aside className="contact-drawer is-open" aria-label="Conectar canal via QR">
            <header className="contact-drawer-header">
              <span className="context-card-title">Conectar via QR</span>
              <button
                className="drawer-close"
                onClick={closeQrDrawer}
                type="button"
                aria-label="Fechar"
              >
                ✕
              </button>
            </header>
            <div className="contact-drawer-body">
              {selectedChannel?.provider === "evolution" ? (
                <ChannelConnectionsPanel key={selectedChannel.id} channel={selectedChannel}
                  primaryQr={qrResult?.channel.id === selectedChannel.id ? qrResult : null}
                  qrEvent={qrEvent} getToken={getToken} onChannel={updatePhysicalChannel}
                  onPrimaryQr={() => void reconnectChannel(selectedChannel)} />
              ) : null}
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
