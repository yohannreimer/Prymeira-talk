export function AssistantPage() {
  return (
    <section className="module-page" aria-label="IA">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>IA</h1>
        </div>
        <span className="status-pill status-pending">Modo simulado</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button">Treinar assistente</button>
        <button className="secondary-button" type="button">Revisar respostas</button>
      </div>

      <div className="module-panel split-panel">
        <div>
          <div className="panel-title-row">
            <h2>Playbooks de IA</h2>
            <span>Assistido</span>
          </div>
          <div className="data-list">
            <div><strong>Resumo da conversa</strong><span>Ativo</span><em>Gera contexto antes da transferencia.</em></div>
            <div><strong>Sugestao de resposta</strong><span>Rascunho</span><em>Ajuda agentes sem enviar automatico.</em></div>
            <div><strong>Classificador de intencao</strong><span>Ativo</span><em>Marca vendas, suporte e financeiro.</em></div>
          </div>
        </div>
        <aside className="side-panel">
          <span>Confianca media</span>
          <strong>87%</strong>
          <p>Resultados simulados para orientar calibragem do assistente.</p>
        </aside>
      </div>
    </section>
  );
}
