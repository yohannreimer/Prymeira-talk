import { Component, type PropsWithChildren } from 'react';

/** A long-lived tab may reference a retired deployment's lazy chunk. */
export class ModuleErrorBoundary extends Component<PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="center-state" role="alert">
      <p>Não foi possível abrir este módulo. Recarregue o aplicativo para tentar novamente.</p>
      <button type="button" onClick={() => window.location.reload()}>Recarregar aplicativo</button>
    </div>;
    return this.props.children;
  }
}
