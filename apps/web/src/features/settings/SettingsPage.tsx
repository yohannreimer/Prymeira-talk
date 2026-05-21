export function SettingsPage() {
  return (
    <section className="module-page" aria-label="Ajustes">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Ajustes</h1>
        </div>
        <span className="status-pill status-open">Workspace local</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button">Salvar ajustes</button>
        <button className="secondary-button" type="button">Auditar acesso</button>
      </div>

      <div className="module-panel split-panel">
        <div>
          <div className="panel-title-row">
            <h2>Configuracao geral</h2>
            <span>Pronto para testes</span>
          </div>
          <div className="data-list">
            <div><strong>Autenticacao</strong><span>Clerk</span><em>Bypass local habilitado no desenvolvimento.</em></div>
            <div><strong>Workspace</strong><span>local_workspace</span><em>Ambiente isolado para validacao.</em></div>
            <div><strong>Notificacoes</strong><span>Internas</span><em>Eventos exibidos no navegador.</em></div>
          </div>
        </div>
        <aside className="side-panel">
          <span>Saude</span>
          <strong>OK</strong>
          <p>Parametros essenciais visiveis antes das integracoes finais.</p>
        </aside>
      </div>
    </section>
  );
}
