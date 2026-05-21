import { useTalkAuth } from "../../app/auth";
import { RefreshCw, Save, Settings2 } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import {
  apiGetAuditLog,
  apiGetSettings,
  apiUpdateSettings,
  type AuditLogDto,
  type IntegrationModeDto,
  type SettingsDto
} from "../../app/api";

export function SettingsPage() {
  const { getToken } = useTalkAuth();
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [auditLog, setAuditLog] = useState<AuditLogDto[]>([]);
  const [provider, setProvider] = useState("atomic_crm");
  const [mode, setMode] = useState<IntegrationModeDto>("simulated");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadSettings() {
    setIsLoading(true);
    setError(null);

    try {
      const [nextSettings, nextAuditLog] = await Promise.all([
        apiGetSettings(getToken),
        apiGetAuditLog(getToken)
      ]);
      setSettings(nextSettings);
      setAuditLog(nextAuditLog);
      const firstIntegration = nextSettings.integrations[0];
      if (firstIntegration) {
        setProvider(firstIntegration.provider);
        setMode(firstIntegration.mode);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar ajustes.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, [getToken]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const nextSettings = await apiUpdateSettings(getToken, { provider, mode });
      setSettings(nextSettings);
      setAuditLog(await apiGetAuditLog(getToken));
      setNotice("Modo de integração atualizado e auditado.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar ajustes.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="module-page" aria-label="Ajustes">
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

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="success-note">{notice}</p> : null}

      <div className="ops-grid">
        <div className="module-panel">
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

          <form className="module-form compact-form" onSubmit={(event) => void saveSettings(event)}>
            <div className="panel-title-row" style={{ paddingBottom: 0 }}>
              <h2>Integração</h2>
            </div>
            <label className="form-field">
              Provider
              <input value={provider} onChange={(event) => setProvider(event.target.value)} required />
            </label>
            <label className="form-field">
              Modo
              <select value={mode} onChange={(event) => setMode(event.target.value as IntegrationModeDto)}>
                <option value="simulated">Simulado</option>
                <option value="real">Real</option>
              </select>
            </label>
            <button className="primary-button" type="submit" disabled={isSaving}>
              <Save size={16} />
              Salvar ajustes
            </button>
          </form>
        </div>

        <div className="module-panel">
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
    </section>
  );
}
