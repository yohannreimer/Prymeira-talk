export function ReportsPage() {
  return (
    <section className="module-page" aria-label="Relatorios">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Relatorios</h1>
        </div>
        <span className="status-pill status-open">Tempo real</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button">Exportar PDF</button>
        <button className="secondary-button" type="button">Filtrar periodo</button>
      </div>

      <div className="metric-grid" aria-label="Indicadores">
        <article className="metric-card"><span>Conversas</span><strong>2.184</strong><p>Volume consolidado do periodo.</p></article>
        <article className="metric-card"><span>Tempo medio</span><strong>4m 12s</strong><p>Primeira resposta da equipe.</p></article>
        <article className="metric-card"><span>SLA</span><strong>96%</strong><p>Atendimentos dentro da meta.</p></article>
      </div>

      <div className="module-panel">
        <div className="panel-title-row">
          <h2>Funil de atendimento</h2>
          <span>Ultimos 30 dias</span>
        </div>
        <div className="bar-list">
          <div><span>Recebidas</span><strong style={{ width: "100%" }} /></div>
          <div><span>Respondidas</span><strong style={{ width: "86%" }} /></div>
          <div><span>Resolvidas</span><strong style={{ width: "72%" }} /></div>
        </div>
      </div>
    </section>
  );
}
