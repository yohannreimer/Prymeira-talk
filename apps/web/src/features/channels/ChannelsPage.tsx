export function ChannelsPage() {
  return (
    <section className="module-page" aria-label="Canais">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Canais</h1>
        </div>
        <span className="status-pill status-pending">Modo simulado</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button">Conectar canal</button>
        <button className="secondary-button" type="button">Testar webhook</button>
      </div>

      <div className="module-panel split-panel">
        <div>
          <div className="panel-title-row">
            <h2>Conexoes</h2>
            <span>Simulado</span>
          </div>
          <div className="data-list">
            <div><strong>WhatsApp Principal</strong><span>Pronto para QR</span><em>Evolution API</em></div>
            <div><strong>WhatsApp Suporte</strong><span>Em pausa</span><em>Fila Atendimento</em></div>
            <div><strong>Instagram DM</strong><span>Planejado</span><em>Entrada omnichannel</em></div>
          </div>
        </div>
        <aside className="side-panel">
          <span>Saude do canal</span>
          <strong>98%</strong>
          <p>Mensagens simuladas fluindo para a fila de atendimento.</p>
        </aside>
      </div>
    </section>
  );
}
