import type { AutomationWebhookDto, ChannelDto } from "@prymeira-talk/shared";
import { Copy, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  apiGetAutomationWebhook,
  apiGetChannels,
  apiRegenerateAutomationWebhook,
  automationWebhookUrl
} from "../../app/api";
import { useTalkAuth } from "../../app/auth";

export const automationWebhookExampleBody = {
  nome: "Joana Silva",
  whatsapp: "(47) 99999-1234",
  empresa: "Metalúrgica Joana",
  faturamento: "R$ 1 a 5 milhões",
  dor: "Caixa apertado",
  equipe: ["Financeiro", "Comercial"],
  utm: { source: "instagram", campaign: "outubro" },
  pagina: "/diagnostico",
  enviado_em: "2026-10-11T12:00:00.000Z"
};

export const metaChannelWebhookWarning =
  "Canal da API oficial (Meta): a primeira mensagem para quem não falou com você nas últimas 24h exige template aprovado, que ainda não está disponível nas automações. Com este canal o contato e o formulário ficam registrados, mas nenhuma mensagem é enviada.";

export function channelOptionLabel(channel: ChannelDto) {
  const name = channel.displayName || channel.phoneNumber || channel.providerKey;
  return channel.provider === "meta_cloud" ? `${name} (API oficial)` : name;
}

interface AutomationWebhookTriggerViewProps {
  automationId: string | null;
  channelId: string;
  channels: ChannelDto[];
  copied: boolean;
  error: string | null;
  isLoading: boolean;
  isRegenerating: boolean;
  onChannelChange: (channelId: string) => void;
  onCopy: () => void;
  onRegenerate: () => void;
  webhook: AutomationWebhookDto | null;
}

export function AutomationWebhookTriggerView({
  automationId,
  channelId,
  channels,
  copied,
  error,
  isLoading,
  isRegenerating,
  onChannelChange,
  onCopy,
  onRegenerate,
  webhook
}: AutomationWebhookTriggerViewProps) {
  const selectedChannel = channels.find((channel) => channel.id === channelId) ?? null;
  const url = webhook ? automationWebhookUrl(webhook.path) : "";

  return (
    <div className="automation-inspector-fields automation-webhook-trigger">
      <label className="form-field">
        <span>Canal do WhatsApp</span>
        <select onChange={(event) => onChannelChange(event.target.value)} value={channelId}>
          <option value="">Selecione um canal</option>
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channelOptionLabel(channel)}
            </option>
          ))}
        </select>
      </label>

      {selectedChannel?.provider === "meta_cloud" ? (
        <p className="automation-webhook-warning" role="alert">
          {metaChannelWebhookWarning}
        </p>
      ) : null}

      <div className="form-field">
        <span>Link do webhook</span>
        {!automationId ? (
          <p className="automation-webhook-hint">Salve o fluxo para gerar o link deste webhook.</p>
        ) : webhook ? (
          <div className="automation-webhook-url">
            <input aria-label="Link do webhook" readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
            <div className="automation-webhook-actions">
              <button className="secondary-button icon-button-label" onClick={onCopy} type="button">
                <Copy size={14} aria-hidden="true" />
                {copied ? "Copiado" : "Copiar link"}
              </button>
              <button
                className="secondary-button icon-button-label"
                disabled={isRegenerating}
                onClick={onRegenerate}
                type="button"
              >
                <RefreshCw size={14} aria-hidden="true" />
                {isRegenerating ? "Gerando..." : "Regenerar link"}
              </button>
            </div>
          </div>
        ) : (
          <p className="automation-webhook-hint">{isLoading ? "Gerando link..." : "Link indisponível."}</p>
        )}
        {error ? <p className="automation-webhook-error">{error}</p> : null}
      </div>

      <p className="automation-webhook-hint">
        Quem tiver o link consegue enviar dados para este fluxo. Regenerar invalida o link anterior. O fluxo
        precisa estar ativo para receber envios.
      </p>

      <details className="automation-webhook-example">
        <summary>Exemplo de envio (POST JSON)</summary>
        <p>
          O telefone vai em <code>whatsapp</code>, <code>telefone</code> ou <code>phone</code>; o nome em{" "}
          <code>nome</code> ou <code>name</code>. Os demais campos aparecem na conversa e podem ser usados como{" "}
          <code>{"{{dor}}"}</code> nas mensagens e na instrução do agente.
        </p>
        <pre>{JSON.stringify(automationWebhookExampleBody, null, 2)}</pre>
      </details>

      <p className="automation-webhook-hint">
        Para o agente puxar a conversa, conecte “Ativar agente” depois deste gatilho com uma instrução de abertura.
        Ele envia a primeira mensagem usando os dados do formulário, após o tempo de espera configurado para respostas.
      </p>
    </div>
  );
}

export function AutomationWebhookTriggerPanel({
  automationId,
  automationRevision,
  channelId,
  onChannelChange
}: {
  automationId: string | null;
  /** Changes after each save so a newly saved webhook trigger gets its link. */
  automationRevision?: string | null;
  channelId: string;
  onChannelChange: (channelId: string) => void;
}) {
  const { getToken } = useTalkAuth();
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [webhook, setWebhook] = useState<AutomationWebhookDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let isMounted = true;

    apiGetChannels(getToken)
      .then((nextChannels) => {
        if (isMounted) setChannels(nextChannels);
      })
      .catch(() => {
        if (isMounted) setError("Não foi possível carregar os canais.");
      });

    return () => {
      isMounted = false;
    };
  }, [getToken]);

  useEffect(() => {
    if (!automationId) {
      setWebhook(null);
      return;
    }

    let isMounted = true;
    setIsLoading(true);
    setError(null);

    apiGetAutomationWebhook(getToken, automationId)
      .then((nextWebhook) => {
        if (isMounted) setWebhook(nextWebhook);
      })
      .catch((loadError) => {
        if (isMounted) {
          setWebhook(null);
          setError(loadError instanceof Error ? loadError.message : "Não foi possível gerar o link.");
        }
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [automationId, automationRevision, getToken]);

  async function copyLink() {
    if (!webhook) return;

    try {
      await navigator.clipboard.writeText(automationWebhookUrl(webhook.path));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Não foi possível copiar. Selecione o link e copie manualmente.");
    }
  }

  async function regenerateLink() {
    if (!automationId) return;

    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm("Gerar um novo link? O link atual para de funcionar imediatamente.");
    if (!confirmed) return;

    setIsRegenerating(true);
    setError(null);

    try {
      setWebhook(await apiRegenerateAutomationWebhook(getToken, automationId));
      setCopied(false);
    } catch (regenerateError) {
      setError(regenerateError instanceof Error ? regenerateError.message : "Não foi possível regenerar o link.");
    } finally {
      setIsRegenerating(false);
    }
  }

  return (
    <AutomationWebhookTriggerView
      automationId={automationId}
      channelId={channelId}
      channels={channels}
      copied={copied}
      error={error}
      isLoading={isLoading}
      isRegenerating={isRegenerating}
      onChannelChange={onChannelChange}
      onCopy={() => void copyLink()}
      onRegenerate={() => void regenerateLink()}
      webhook={webhook}
    />
  );
}
