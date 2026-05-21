export function AutomationsPage() {
  return (
    <section className="module-page" aria-label="Automacoes">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Automacoes</h1>
        </div>
        <span className="status-pill status-pending">Modo simulado</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button">Criar fluxo</button>
        <button className="secondary-button" type="button">Ver modelos</button>
      </div>

      <div className="module-panel">
        <div className="panel-title-row">
          <h2>Fluxos recomendados</h2>
          <span>3 ativos</span>
        </div>
        <div className="workflow-list">
          <article><span>01</span><strong>Boas-vindas</strong><p>Envia saudacao e coleta motivo do contato.</p></article>
          <article><span>02</span><strong>Triagem comercial</strong><p>Classifica interesse e prioridade antes da equipe.</p></article>
          <article><span>03</span><strong>Pesquisa NPS</strong><p>Dispara avaliacao apos conversa fechada.</p></article>
        </div>
      </div>
    </section>
  );
}
