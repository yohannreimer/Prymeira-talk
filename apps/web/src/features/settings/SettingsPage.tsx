import { useTalkAuth } from "../../app/auth";
import { Activity, Bot, Cable, PlugZap, RefreshCw, Save, Settings2, Tags, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  apiCreateTag,
  apiDeleteTag,
  apiGetAuditLog,
  apiGetSettings,
  apiGetTags,
  apiSyncMetaTemplates,
  apiUpdateAgentBehavior,
  apiUpdateSettings,
  apiUpdateTag,
  type AuditLogDto,
  type SettingsDto,
  type TagDto
} from "../../app/api";

interface MetaCloudFormState {
  enabled: boolean;
  connectionMode: "direct" | "evolution_official";
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  webhookVerifyToken: string;
  appSecret: string;
  evolutionBaseUrl: string;
  evolutionApiKey: string;
  evolutionInstanceName: string;
  storedSecrets: {
    accessToken: boolean;
    webhookVerifyToken: boolean;
    appSecret: boolean;
    evolutionApiKey: boolean;
  };
}

interface AiProviderFormState {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  storedSecrets: {
    apiKey: boolean;
  };
}

interface TagFormState {
  name: string;
  color: string;
  useGuide: string;
}

const emptyMetaForm: MetaCloudFormState = {
  enabled: false,
  connectionMode: "direct",
  wabaId: "",
  phoneNumberId: "",
  accessToken: "",
  webhookVerifyToken: "",
  appSecret: "",
  evolutionBaseUrl: "",
  evolutionApiKey: "",
  evolutionInstanceName: "",
  storedSecrets: {
    accessToken: false,
    webhookVerifyToken: false,
    appSecret: false,
    evolutionApiKey: false
  }
};

const emptyAiProviderForm: AiProviderFormState = {
  enabled: false,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  chatModel: "gpt-5.6-luna",
  storedSecrets: {
    apiKey: false
  }
};

const emptyTagForm: TagFormState = {
  name: "",
  color: "#2f6b57",
  useGuide: ""
};

function sortTags(tags: TagDto[]) {
  return [...tags].sort((first, second) => first.name.localeCompare(second.name, "pt-BR"));
}

function asSettingsRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasStoredSecret(value: unknown) {
  return typeof value === "string" && value.length > 0;
}

function getMetaCloudForm(settings: SettingsDto): MetaCloudFormState {
  const integration = settings.integrations.find((config) => config.provider === "meta_cloud");
  const integrationSettings = asSettingsRecord(integration?.settings);

  return {
    enabled: integrationSettings.enabled === true && integration?.mode === "real",
    connectionMode: integrationSettings.connectionMode === "evolution_official"
      ? "evolution_official"
      : "direct",
    wabaId: typeof integrationSettings.wabaId === "string" ? integrationSettings.wabaId : "",
    phoneNumberId: typeof integrationSettings.phoneNumberId === "string" ? integrationSettings.phoneNumberId : "",
    accessToken: "",
    webhookVerifyToken: "",
    appSecret: "",
    evolutionBaseUrl: typeof integrationSettings.evolutionBaseUrl === "string" ? integrationSettings.evolutionBaseUrl : "",
    evolutionApiKey: "",
    evolutionInstanceName: typeof integrationSettings.evolutionInstanceName === "string" ? integrationSettings.evolutionInstanceName : "",
    storedSecrets: {
      accessToken: hasStoredSecret(integrationSettings.accessToken),
      webhookVerifyToken: hasStoredSecret(integrationSettings.webhookVerifyToken),
      appSecret: hasStoredSecret(integrationSettings.appSecret),
      evolutionApiKey: hasStoredSecret(integrationSettings.evolutionApiKey)
    }
  };
}

export function getAiProviderForm(settings: SettingsDto): AiProviderFormState {
  const integration = settings.integrations.find((config) => config.provider === "openai_compatible");
  const integrationSettings = asSettingsRecord(integration?.settings);

  return {
    enabled: integration?.mode === "real",
    baseUrl: typeof integrationSettings.baseUrl === "string"
      ? integrationSettings.baseUrl
      : emptyAiProviderForm.baseUrl,
    apiKey: "",
    chatModel: typeof integrationSettings.chatModel === "string"
      ? integrationSettings.chatModel
      : emptyAiProviderForm.chatModel,
    storedSecrets: {
      apiKey: hasStoredSecret(integrationSettings.apiKey)
    }
  };
}

export function getAgentReplyWaitSeconds(settings: Pick<SettingsDto, "behavior"> | Partial<SettingsDto>) {
  const value = settings.behavior?.agentReplyWaitSeconds;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 300
    ? String(value)
    : "40";
}

function setTrimmedValue(target: Record<string, unknown>, key: string, value: string) {
  const trimmed = value.trim();

  if (trimmed) {
    target[key] = trimmed;
  }
}

export function SettingsPage() {
  const { getToken } = useTalkAuth();
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [auditLog, setAuditLog] = useState<AuditLogDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [metaForm, setMetaForm] = useState<MetaCloudFormState>(emptyMetaForm);
  const [aiProviderForm, setAiProviderForm] = useState<AiProviderFormState>(emptyAiProviderForm);
  const [tagForm, setTagForm] = useState<TagFormState>(emptyTagForm);
  const [agentReplyWaitSeconds, setAgentReplyWaitSeconds] = useState("40");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingBehavior, setIsSavingBehavior] = useState(false);
  const [isSavingTag, setIsSavingTag] = useState(false);
  const [savingTagId, setSavingTagId] = useState<string | null>(null);
  const [isSyncingTemplates, setIsSyncingTemplates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadSettings() {
    setIsLoading(true);
    setError(null);

    try {
      const [nextSettings, nextAuditLog, nextTags] = await Promise.all([
        apiGetSettings(getToken),
        apiGetAuditLog(getToken),
        apiGetTags(getToken)
      ]);
      setSettings(nextSettings);
      setAuditLog(nextAuditLog);
      setTags(sortTags(nextTags));
      setMetaForm(getMetaCloudForm(nextSettings));
      setAiProviderForm(getAiProviderForm(nextSettings));
      setAgentReplyWaitSeconds(getAgentReplyWaitSeconds(nextSettings));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar ajustes.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, [getToken]);

  const canSyncMetaTemplates = useMemo(() => (
    metaForm.enabled &&
    metaForm.connectionMode === "direct" &&
    metaForm.wabaId.trim().length > 0 &&
    metaForm.phoneNumberId.trim().length > 0 &&
    (metaForm.accessToken.trim().length > 0 || metaForm.storedSecrets.accessToken) &&
    (metaForm.webhookVerifyToken.trim().length > 0 || metaForm.storedSecrets.webhookVerifyToken) &&
    (metaForm.appSecret.trim().length > 0 || metaForm.storedSecrets.appSecret)
  ), [metaForm]);

  function updateMetaForm(partial: Partial<MetaCloudFormState>) {
    setMetaForm((current) => ({ ...current, ...partial }));
  }

  function updateAiProviderForm(partial: Partial<AiProviderFormState>) {
    setAiProviderForm((current) => ({ ...current, ...partial }));
  }

  function updateTagForm(partial: Partial<TagFormState>) {
    setTagForm((current) => ({ ...current, ...partial }));
  }

  function buildMetaSettingsPayload() {
    const nextSettings: Record<string, unknown> = {
      enabled: metaForm.enabled,
      connectionMode: metaForm.connectionMode
    };

    setTrimmedValue(nextSettings, "wabaId", metaForm.wabaId);
    setTrimmedValue(nextSettings, "phoneNumberId", metaForm.phoneNumberId);
    setTrimmedValue(nextSettings, "accessToken", metaForm.accessToken);
    setTrimmedValue(nextSettings, "webhookVerifyToken", metaForm.webhookVerifyToken);
    setTrimmedValue(nextSettings, "appSecret", metaForm.appSecret);
    setTrimmedValue(nextSettings, "evolutionBaseUrl", metaForm.evolutionBaseUrl);
    setTrimmedValue(nextSettings, "evolutionApiKey", metaForm.evolutionApiKey);
    setTrimmedValue(nextSettings, "evolutionInstanceName", metaForm.evolutionInstanceName);

    return nextSettings;
  }

  function buildAiProviderSettingsPayload() {
    const nextSettings: Record<string, unknown> = {};

    setTrimmedValue(nextSettings, "baseUrl", aiProviderForm.baseUrl);
    setTrimmedValue(nextSettings, "apiKey", aiProviderForm.apiKey);
    setTrimmedValue(nextSettings, "chatModel", aiProviderForm.chatModel);

    return nextSettings;
  }

  function validateMetaSettings() {
    if (!metaForm.enabled) return null;

    if (metaForm.connectionMode === "evolution_official") {
      if (!metaForm.evolutionBaseUrl.trim()) return "Informe a URL da Evolution.";
      if (!metaForm.evolutionApiKey.trim() && !metaForm.storedSecrets.evolutionApiKey) {
        return "Informe a API key da Evolution.";
      }

      return null;
    }

    if (!metaForm.wabaId.trim()) return "Informe o WABA ID.";
    if (!metaForm.phoneNumberId.trim()) return "Informe o Phone Number ID.";
    if (!metaForm.accessToken.trim() && !metaForm.storedSecrets.accessToken) return "Informe o Access Token.";
    if (!metaForm.webhookVerifyToken.trim() && !metaForm.storedSecrets.webhookVerifyToken) {
      return "Informe o Webhook Verify Token.";
    }
    if (!metaForm.appSecret.trim() && !metaForm.storedSecrets.appSecret) return "Informe o App Secret.";

    return null;
  }

  function validateAiProviderSettings() {
    if (!aiProviderForm.enabled) return null;

    try {
      const baseUrl = new URL(aiProviderForm.baseUrl.trim());

      if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
        return "Informe uma Base URL valida para a IA.";
      }
    } catch {
      return "Informe uma Base URL valida para a IA.";
    }

    if (!aiProviderForm.chatModel.trim()) return "Informe o modelo de chat.";
    if (!aiProviderForm.apiKey.trim() && !aiProviderForm.storedSecrets.apiKey) {
      return "Informe a API Key do provider de IA.";
    }

    return null;
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const validationError = validateMetaSettings();
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSaving(true);

    try {
      const nextSettings = await apiUpdateSettings(getToken, {
        provider: "meta_cloud",
        mode: metaForm.enabled ? "real" : "simulated",
        settings: buildMetaSettingsPayload()
      });
      setSettings(nextSettings);
      setMetaForm(getMetaCloudForm(nextSettings));
      setAuditLog(await apiGetAuditLog(getToken));
      setNotice(metaForm.enabled ? "WhatsApp API Oficial Meta ativada." : "WhatsApp API Oficial Meta desativada.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar ajustes.");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveAiProviderSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const validationError = validateAiProviderSettings();
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSaving(true);

    try {
      const nextSettings = await apiUpdateSettings(getToken, {
        provider: "openai_compatible",
        mode: aiProviderForm.enabled ? "real" : "simulated",
        settings: buildAiProviderSettingsPayload()
      });
      setSettings(nextSettings);
      setAiProviderForm(getAiProviderForm(nextSettings));
      setAuditLog(await apiGetAuditLog(getToken));
      setNotice(aiProviderForm.enabled ? "Provider de IA ativado." : "Provider de IA desativado.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar ajustes.");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveAgentBehavior(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const value = Number(agentReplyWaitSeconds);
    if (!agentReplyWaitSeconds.trim() || !Number.isInteger(value) || value < 0 || value > 300) {
      setError("Informe um tempo inteiro entre 0 e 300 segundos.");
      return;
    }

    setIsSavingBehavior(true);

    try {
      const nextSettings = await apiUpdateAgentBehavior(getToken, {
        agentReplyWaitSeconds: value
      });
      setSettings(nextSettings);
      setAgentReplyWaitSeconds(getAgentReplyWaitSeconds(nextSettings));
      setAuditLog(await apiGetAuditLog(getToken));
      setNotice(value === 0
        ? "Os agentes responderão imediatamente."
        : `Os agentes aguardarão ${value} segundos após a última mensagem.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar o comportamento dos agentes.");
    } finally {
      setIsSavingBehavior(false);
    }
  }

  async function syncMetaTemplates() {
    setIsSyncingTemplates(true);
    setError(null);
    setNotice(null);

    try {
      const result = await apiSyncMetaTemplates(getToken);
      setAuditLog(await apiGetAuditLog(getToken));
      setNotice(`${result.synced} templates aprovados sincronizados.`);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Não foi possível sincronizar templates.");
    } finally {
      setIsSyncingTemplates(false);
    }
  }

  async function createTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const name = tagForm.name.trim();
    const useGuide = tagForm.useGuide.trim();

    if (!name) {
      setError("Informe o nome da tag.");
      return;
    }

    if (!useGuide) {
      setError("Informe quando usar a tag.");
      return;
    }

    setIsSavingTag(true);

    try {
      const nextTag = await apiCreateTag(getToken, {
        name,
        color: tagForm.color,
        useGuide
      });
      setTags((current) => sortTags([...current, nextTag]));
      setTagForm(emptyTagForm);
      setNotice("Tag da IA criada.");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Não foi possível criar a tag.");
    } finally {
      setIsSavingTag(false);
    }
  }

  async function toggleTagStatus(tag: TagDto) {
    setError(null);
    setNotice(null);
    setSavingTagId(tag.id);

    try {
      const nextTag = await apiUpdateTag(getToken, tag.id, { isActive: !tag.isActive });
      setTags((current) => sortTags(current.map((currentTag) => (
        currentTag.id === nextTag.id ? nextTag : currentTag
      ))));
      setNotice(nextTag.isActive ? "Tag da IA ativada." : "Tag da IA desativada.");
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Não foi possível atualizar a tag.");
    } finally {
      setSavingTagId(null);
    }
  }

  async function deleteTag(tag: TagDto) {
    const usageCount = (tag.agentCount ?? 0) + (tag.conversationCount ?? 0);
    const confirmation = usageCount > 0
      ? `Excluir "${tag.name}"? Ela sera removida de ${tag.agentCount ?? 0} agentes e ${tag.conversationCount ?? 0} conversas.`
      : `Excluir "${tag.name}"?`;

    if (!window.confirm(confirmation)) return;

    setError(null);
    setNotice(null);
    setSavingTagId(tag.id);

    try {
      const deletedTag = await apiDeleteTag(getToken, tag.id);
      setTags((current) => current.filter((currentTag) => currentTag.id !== deletedTag.id));
      setNotice("Tag da IA excluida.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Não foi possível excluir a tag.");
    } finally {
      setSavingTagId(null);
    }
  }

  return (
    <section className="module-page settings-page" aria-label="Ajustes">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Ajustes</h1>
        </div>
        <div className="module-header-actions">
          <span className={`status-badge status-badge--${isLoading ? "waiting" : "open"}`}>
            {isLoading ? "Carregando" : (settings?.workspace.workspaceId ?? "Workspace")}
          </span>
          <button className="secondary-button" type="button" onClick={() => void loadSettings()}>
            <RefreshCw size={14} />
            Atualizar
          </button>
        </div>
      </header>

      {error ? <p className="error-note" role="alert">{error}</p> : null}
      {notice ? <p className="success-note" role="status" aria-live="polite">{notice}</p> : null}

      <div className="settings-overview-grid" aria-label="Resumo dos ajustes">
        <div className="settings-overview-card">
          <Settings2 size={18} aria-hidden="true" />
          <span>Workspace</span>
          <strong>{settings?.workspace.name ?? "Sem nome"}</strong>
          <small>{settings?.workspace.plan ?? "Free"}</small>
        </div>
        <div className="settings-overview-card">
          <Bot size={18} aria-hidden="true" />
          <span>Provider de IA</span>
          <strong>{aiProviderForm.enabled ? "Real" : "Simulado"}</strong>
          <small>{aiProviderForm.chatModel || "Modelo não definido"}</small>
        </div>
        <div className="settings-overview-card">
          <Cable size={18} aria-hidden="true" />
          <span>WhatsApp Meta</span>
          <strong>{metaForm.enabled ? "Ativa" : "Inativa"}</strong>
          <small>{metaForm.connectionMode === "direct" ? "Direto na Meta" : "Via Evolution"}</small>
        </div>
        <div className="settings-overview-card">
          <Tags size={18} aria-hidden="true" />
          <span>Tags oficiais</span>
          <strong>{tags.length}</strong>
          <small>{tags.filter((tag) => tag.isActive).length} ativas</small>
        </div>
      </div>

      <div className="settings-workbench">
        <nav className="settings-nav" aria-label="Seções de ajustes">
          <a href="#settings-workspace"><Settings2 size={15} aria-hidden="true" />Workspace</a>
          <a href="#settings-agent-behavior"><Bot size={15} aria-hidden="true" />Comportamento</a>
          <a href="#settings-ai"><Bot size={15} aria-hidden="true" />Provider de IA</a>
          <a href="#settings-whatsapp"><Cable size={15} aria-hidden="true" />WhatsApp Meta</a>
          <a href="#settings-tags"><Tags size={15} aria-hidden="true" />Tags da IA</a>
          <a href="#settings-audit"><Activity size={15} aria-hidden="true" />Auditoria</a>
        </nav>

        <div className="settings-stack">
        <div className="module-panel settings-card" id="settings-workspace">
          <div className="panel-title-row">
            <h2>Workspace</h2>
            {settings ? (
              <span className="status-badge status-badge--open">{settings.workspace.plan ?? "Free"}</span>
            ) : null}
          </div>

          {settings ? (
            <div className="settings-info-rows">
              <div className="settings-info-row">
                <span>Nome</span>
                <strong>{settings.workspace.name ?? "Sem nome"}</strong>
              </div>
              <div className="settings-info-row">
                <span>ID</span>
                <strong className="settings-info-mono">{settings.workspace.workspaceId}</strong>
              </div>
              <div className="settings-info-row">
                <span>Integrações</span>
                <strong>{settings.integrations.length}</strong>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Settings2 size={24} />
              </div>
              <h3>Nenhum ajuste carregado</h3>
              <p>Atualize para consultar o workspace.</p>
            </div>
          )}

          <form className="module-form compact-form settings-card-form" id="settings-whatsapp" onSubmit={(event) => void saveSettings(event)}>
            <div className="panel-title-row" style={{ paddingBottom: 0 }}>
              <h2>WhatsApp API Oficial Meta</h2>
              <div className="segmented-control" aria-label="Status da Meta">
                <button
                  className={!metaForm.enabled ? "is-active" : ""}
                  onClick={() => updateMetaForm({ enabled: false })}
                  type="button"
                >
                  Inativa
                </button>
                <button
                  className={metaForm.enabled ? "is-active" : ""}
                  onClick={() => updateMetaForm({ enabled: true })}
                  type="button"
                >
                  Ativa
                </button>
              </div>
            </div>

            {metaForm.enabled ? (
              <>
                <div className="segmented-control" aria-label="Modo de conexão Meta">
                  <button
                    className={metaForm.connectionMode === "direct" ? "is-active" : ""}
                    onClick={() => updateMetaForm({ connectionMode: "direct" })}
                    type="button"
                  >
                    Direto na Meta
                  </button>
                  <button
                    className={metaForm.connectionMode === "evolution_official" ? "is-active" : ""}
                    onClick={() => updateMetaForm({ connectionMode: "evolution_official" })}
                    type="button"
                  >
                    Via Evolution
                  </button>
                </div>

                {metaForm.connectionMode === "direct" ? (
                  <>
                    <label className="form-field">
                      WABA ID
                      <input
                        autoComplete="off"
                        onChange={(event) => updateMetaForm({ wabaId: event.target.value })}
                        required
                        value={metaForm.wabaId}
                      />
                    </label>
                    <label className="form-field">
                      Phone Number ID
                      <input
                        autoComplete="off"
                        onChange={(event) => updateMetaForm({ phoneNumberId: event.target.value })}
                        required
                        value={metaForm.phoneNumberId}
                      />
                    </label>
                    <label className="form-field">
                      Access Token
                      <input
                        autoComplete="new-password"
                        onChange={(event) => updateMetaForm({ accessToken: event.target.value })}
                        placeholder={metaForm.storedSecrets.accessToken ? "Token já salvo" : "Cole o token da Meta"}
                        required={!metaForm.storedSecrets.accessToken}
                        type="password"
                        value={metaForm.accessToken}
                      />
                    </label>
                    <label className="form-field">
                      Webhook Verify Token
                      <input
                        autoComplete="new-password"
                        onChange={(event) => updateMetaForm({ webhookVerifyToken: event.target.value })}
                        placeholder={metaForm.storedSecrets.webhookVerifyToken ? "Token já salvo" : "Defina o token de verificação"}
                        required={!metaForm.storedSecrets.webhookVerifyToken}
                        type="password"
                        value={metaForm.webhookVerifyToken}
                      />
                    </label>
                    <label className="form-field">
                      App Secret
                      <input
                        autoComplete="new-password"
                        onChange={(event) => updateMetaForm({ appSecret: event.target.value })}
                        placeholder={metaForm.storedSecrets.appSecret ? "Segredo já salvo" : "Cole o App Secret"}
                        required={!metaForm.storedSecrets.appSecret}
                        type="password"
                        value={metaForm.appSecret}
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="form-field">
                      Evolution Base URL
                      <input
                        autoComplete="off"
                        onChange={(event) => updateMetaForm({ evolutionBaseUrl: event.target.value })}
                        placeholder="https://wsapi.seudominio.com.br"
                        required
                        value={metaForm.evolutionBaseUrl}
                      />
                    </label>
                    <label className="form-field">
                      API key da Evolution
                      <input
                        autoComplete="new-password"
                        onChange={(event) => updateMetaForm({ evolutionApiKey: event.target.value })}
                        placeholder={metaForm.storedSecrets.evolutionApiKey ? "API key já salva" : "Cole a API key da Evolution"}
                        required={!metaForm.storedSecrets.evolutionApiKey}
                        type="password"
                        value={metaForm.evolutionApiKey}
                      />
                    </label>
                    <p className="list-note">
                      Os Instance names ficam em Canais, um por número oficial Meta.
                    </p>
                  </>
                )}
              </>
            ) : (
              <p className="list-note">A integração oficial fica oculta no app até ser ativada aqui.</p>
            )}

            <div className="module-header-actions">
              <button className="primary-button" type="submit" disabled={isSaving}>
                <Save size={16} />
                Salvar ajustes
              </button>
              {metaForm.enabled && metaForm.connectionMode === "direct" ? (
                <button
                  className="secondary-button"
                  disabled={isSyncingTemplates || !canSyncMetaTemplates}
                  onClick={() => void syncMetaTemplates()}
                  type="button"
                >
                  <PlugZap size={14} />
                  Sincronizar templates
                </button>
              ) : null}
            </div>
          </form>
        </div>

        <form
          className="module-panel module-form settings-card"
          id="settings-agent-behavior"
          onSubmit={(event) => void saveAgentBehavior(event)}
        >
          <div className="panel-title-row">
            <h2>Comportamento dos agentes</h2>
          </div>

          <label className="form-field">
            Tempo de espera após a última mensagem
            <input
              inputMode="numeric"
              max={300}
              min={0}
              onChange={(event) => setAgentReplyWaitSeconds(event.target.value)}
              required
              step={1}
              type="number"
              value={agentReplyWaitSeconds}
            />
          </label>

          <p className="list-note">
            Cada nova mensagem reinicia a contagem. Use 0 para responder imediatamente.
          </p>

          <div className="module-header-actions">
            <button className="primary-button" type="submit" disabled={isSavingBehavior}>
              <Save size={16} />
              Salvar comportamento
            </button>
          </div>
        </form>

        <form className="module-panel module-form settings-card" id="settings-ai" onSubmit={(event) => void saveAiProviderSettings(event)}>
          <div className="panel-title-row">
            <h2>Provider de IA</h2>
            <span className={`status-badge status-badge--${aiProviderForm.enabled ? "open" : "waiting"}`}>
              {aiProviderForm.enabled ? "Ativo" : "Simulado"}
            </span>
          </div>

          <label className="form-field">
            Modo
            <select
              onChange={(event) => updateAiProviderForm({ enabled: event.target.value === "real" })}
              value={aiProviderForm.enabled ? "real" : "simulated"}
            >
              <option value="simulated">Simulado</option>
              <option value="real">Real</option>
            </select>
          </label>

          <label className="form-field">
            Base URL
            <input
              autoComplete="off"
              onChange={(event) => updateAiProviderForm({ baseUrl: event.target.value })}
              required={aiProviderForm.enabled}
              type="url"
              value={aiProviderForm.baseUrl}
            />
          </label>

          <label className="form-field">
            API Key
            <input
              autoComplete="new-password"
              onChange={(event) => updateAiProviderForm({ apiKey: event.target.value })}
              placeholder={aiProviderForm.storedSecrets.apiKey ? "Chave salva" : "sk-..."}
              required={aiProviderForm.enabled && !aiProviderForm.storedSecrets.apiKey}
              type="password"
              value={aiProviderForm.apiKey}
            />
            {aiProviderForm.storedSecrets.apiKey ? (
              <span className="list-note">Deixe em branco para manter a chave salva.</span>
            ) : null}
          </label>

          <label className="form-field">
            Modelo de chat
            <input
              autoComplete="off"
              onChange={(event) => updateAiProviderForm({ chatModel: event.target.value })}
              required={aiProviderForm.enabled}
              value={aiProviderForm.chatModel}
            />
          </label>

          <div className="module-header-actions">
            <button className="primary-button" type="submit" disabled={isSaving}>
              <Save size={16} />
              Salvar IA
            </button>
          </div>
        </form>

        <div className="module-panel settings-card" id="settings-tags">
          <div className="panel-title-row">
            <h2>Tags da IA</h2>
            <span>{tags.length} tags</span>
          </div>

          <form className="module-form compact-form tag-settings-form" onSubmit={(event) => void createTag(event)}>
            <label className="form-field">
              Nome da tag
              <input
                autoComplete="off"
                onChange={(event) => updateTagForm({ name: event.target.value })}
                placeholder="Lead quente"
                required
                value={tagForm.name}
              />
            </label>

            <label className="form-field">
              Cor
              <input
                aria-label="Cor"
                onChange={(event) => updateTagForm({ color: event.target.value })}
                type="color"
                value={tagForm.color}
              />
            </label>

            <label className="form-field tag-settings-form__guide">
              Quando usar
              <textarea
                onChange={(event) => updateTagForm({ useGuide: event.target.value })}
                placeholder="Quando o cliente demonstrar intenção clara de compra."
                required
                rows={4}
                value={tagForm.useGuide}
              />
            </label>

            <div className="module-header-actions tag-settings-form__actions">
              <button className="primary-button" type="submit" disabled={isSavingTag}>
                <Save size={16} />
                Criar tag
              </button>
            </div>
          </form>

          {tags.length === 0 ? (
            <p className="list-note">Nenhuma tag global cadastrada.</p>
          ) : (
            <div className="settings-tag-list">
              {tags.map((tag) => (
                <div key={tag.id} className="settings-tag-row">
                  <div className="settings-tag-row__main">
                    <span
                      className="settings-tag-swatch"
                      style={{ backgroundColor: tag.color }}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>{tag.name}</strong>
                      <p>{tag.useGuide}</p>
                    </div>
                  </div>
                  <div className="settings-tag-row__meta">
                    <span className={`status-badge status-badge--${tag.isActive ? "open" : "waiting"}`}>
                      {tag.isActive ? "Ativa" : "Inativa"}
                    </span>
                    <span>{tag.agentCount ?? 0} agentes</span>
                    <span>{tag.conversationCount ?? 0} conversas</span>
                  </div>
                  <div className="settings-tag-row__actions">
                    <button
                      className="secondary-button"
                      disabled={savingTagId === tag.id}
                      onClick={() => void toggleTagStatus(tag)}
                      type="button"
                    >
                      {tag.isActive ? "Desativar" : "Ativar"}
                    </button>
                    <button
                      aria-label={`Excluir tag ${tag.name}`}
                      className="icon-button danger-icon-button"
                      disabled={savingTagId === tag.id}
                      onClick={() => void deleteTag(tag)}
                      title="Excluir tag"
                      type="button"
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="module-panel settings-card" id="settings-audit">
          <div className="panel-title-row">
            <h2>Audit log</h2>
            <span>{auditLog.length} eventos</span>
          </div>
          {auditLog.length === 0 ? (
            <p className="list-note">Nenhum evento de auditoria.</p>
          ) : null}
          <div className="audit-log-list">
            {auditLog.map((entry) => (
              <div key={entry.id} className="audit-log-row">
                <span className="status-badge status-badge--closed">{entry.targetType}</span>
                <strong>{entry.action}</strong>
                <span className="audit-log-target">{entry.targetId ?? entry.workspaceId}</span>
              </div>
            ))}
          </div>
        </div>
        </div>
      </div>
    </section>
  );
}
