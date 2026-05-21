export function TeamPage() {
  return (
    <section className="module-page" aria-label="Equipe">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Equipe</h1>
        </div>
        <span className="status-pill status-open">Operacao ativa</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button">Convidar agente</button>
        <button className="secondary-button" type="button">Criar fila</button>
      </div>

      <div className="module-panel">
        <div className="panel-title-row">
          <h2>Agentes em turno</h2>
          <span>6 online</span>
        </div>
        <div className="data-list">
          <div><strong>Camila Rocha</strong><span>Online</span><em>Fila comercial</em></div>
          <div><strong>Bruno Lima</strong><span>Ocupado</span><em>Fila suporte</em></div>
          <div><strong>Ana Torres</strong><span>Online</span><em>Fila sucesso</em></div>
        </div>
      </div>
    </section>
  );
}
