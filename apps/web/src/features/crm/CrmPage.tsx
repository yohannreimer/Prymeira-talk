export function CrmPage() {
  return (
    <section className="module-page" aria-label="Atomic CRM">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Atomic CRM</h1>
        </div>
        <span className="status-pill status-pending">Modo simulado</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button">Vincular pipeline</button>
        <button className="secondary-button" type="button">Mapear campos</button>
      </div>

      <div className="metric-grid" aria-label="Resumo Atomic CRM">
        <article className="metric-card"><span>Leads ligados</span><strong>312</strong><p>Contatos do Talk com negocio aberto.</p></article>
        <article className="metric-card"><span>Receita prevista</span><strong>R$ 82k</strong><p>Pipeline simulado para conversas ativas.</p></article>
        <article className="metric-card"><span>Sem vinculo</span><strong>41</strong><p>Conversas prontas para associar ao CRM.</p></article>
      </div>

      <div className="module-panel">
        <div className="panel-title-row">
          <h2>Pipeline conectado</h2>
          <span>Simulado</span>
        </div>
        <div className="data-list">
          <div><strong>Novo lead</strong><span>124 negocios</span><em>Entrada via atendimento</em></div>
          <div><strong>Proposta</strong><span>38 negocios</span><em>Aguardando retorno</em></div>
          <div><strong>Fechado</strong><span>19 negocios</span><em>Ultimos 30 dias</em></div>
        </div>
      </div>
    </section>
  );
}
