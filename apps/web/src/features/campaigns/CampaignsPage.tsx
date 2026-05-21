export function CampaignsPage() {
  return (
    <section className="module-page" aria-label="Disparos">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Disparos</h1>
        </div>
        <span className="status-pill status-pending">Modo simulado</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button">Novo disparo</button>
        <button className="secondary-button" type="button">Agendar lote</button>
      </div>

      <div className="metric-grid" aria-label="Resumo de disparos">
        <article className="metric-card"><span>Na fila</span><strong>4.580</strong><p>Mensagens aguardando janela.</p></article>
        <article className="metric-card"><span>Entregues</span><strong>92%</strong><p>Taxa simulada das ultimas campanhas.</p></article>
        <article className="metric-card"><span>Respostas</span><strong>18%</strong><p>Contatos que voltaram para atendimento.</p></article>
      </div>

      <div className="module-panel">
        <div className="panel-title-row">
          <h2>Campanhas recentes</h2>
          <span>Modo teste</span>
        </div>
        <div className="data-list">
          <div><strong>Promocao Maio</strong><span>Agendada</span><em>1.800 contatos</em></div>
          <div><strong>Reativacao VIP</strong><span>Rascunho</span><em>320 contatos</em></div>
          <div><strong>Pos-venda</strong><span>Concluida</span><em>740 contatos</em></div>
        </div>
      </div>
    </section>
  );
}
