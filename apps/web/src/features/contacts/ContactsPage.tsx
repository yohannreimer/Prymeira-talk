export function ContactsPage() {
  return (
    <section className="module-page" aria-label="Contatos">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Contatos</h1>
        </div>
        <span className="status-pill status-open">Base unificada</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button">Novo contato</button>
        <button className="secondary-button" type="button">Importar CSV</button>
      </div>

      <div className="metric-grid" aria-label="Resumo de contatos">
        <article className="metric-card">
          <span>Total</span>
          <strong>1.248</strong>
          <p>Leads e clientes com historico no Talk.</p>
        </article>
        <article className="metric-card">
          <span>Novos hoje</span>
          <strong>36</strong>
          <p>Entradas vindas de WhatsApp e formularios.</p>
        </article>
        <article className="metric-card">
          <span>Sem dono</span>
          <strong>84</strong>
          <p>Contatos esperando criterio de distribuicao.</p>
        </article>
      </div>

      <div className="module-panel">
        <div className="panel-title-row">
          <h2>Segmentos ativos</h2>
          <span>Atualizado agora</span>
        </div>
        <div className="data-list">
          <div><strong>Clientes ativos</strong><span>420 contatos</span><em>Com compra recente</em></div>
          <div><strong>Oportunidades quentes</strong><span>118 contatos</span><em>Responderam nos ultimos 7 dias</em></div>
          <div><strong>Reativacao</strong><span>256 contatos</span><em>Sem conversa ha 30 dias</em></div>
        </div>
      </div>
    </section>
  );
}
