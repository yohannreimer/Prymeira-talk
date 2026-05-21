import { useAuth } from "@clerk/clerk-react";
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
  const { getToken } = useAuth();
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
      setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar ajustes.");
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
      setNotice("Modo de integracao atualizado e auditado.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel salvar ajustes.");
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
        <span className="status-pill status-open">
          {isLoading ? "Carregando" : settings?.workspace.workspaceId ?? "Workspace"}
        </span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button" onClick={() => void loadSettings()}>
          <RefreshCw size={16} />
          Atualizar
        </button>
      </div>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="success-note">{notice}</p> : null}

      <div className="ops-grid">
        <div className="module-panel">
          <div className="panel-title-row">
            <h2>Workspace</h2>
            <span>{settings?.workspace.plan ?? "Sem plano"}</span>
          </div>
          {settings ? (
            <div className="data-list">
              <div>
                <strong>{settings.workspace.name ?? "Workspace sem nome"}</strong>
                <span>ID</span>
                <em>{settings.workspace.workspaceId}</em>
              </div>
              <div>
                <strong>Integracoes</strong>
                <span>{settings.integrations.length}</span>
                <em>Configuracoes por provider.</em>
              </div>
            </div>
          ) : (
            <div className="empty-panel">
              <Settings2 size={28} />
              <h3>Nenhum ajuste carregado</h3>
              <p>Atualize para consultar o workspace.</p>
            </div>
          )}

          <form className="module-form" onSubmit={(event) => void saveSettings(event)}>
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
          <div className="data-list">
            {auditLog.length === 0 ? <p className="list-note">Nenhum evento de auditoria.</p> : null}
            {auditLog.map((entry) => (
              <div key={entry.id}>
                <strong>{entry.action}</strong>
                <span>{entry.targetType}</span>
                <em>{entry.targetId ?? entry.workspaceId}</em>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
