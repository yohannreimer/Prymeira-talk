import { useState } from 'react';
import { apiCompareChannelHistory, type HistoryComparison } from '../../app/api';

/** Homologation aid: compares what each engine returns for the same recent chats, matched by exact message id.
 * It reads only; nothing is imported or changed. */
export function HistoryComparisonPanel({ channelId, getToken }: { channelId: string; getToken: () => Promise<string | null> }) {
  const [result, setResult] = useState<HistoryComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function compare() {
    setBusy(true); setError(null);
    try { setResult(await apiCompareChannelHistory(getToken, channelId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível comparar o histórico.'); }
    finally { setBusy(false); }
  }
  const stats = result ? [['Evolution', result.totals.evolution], ['WAHA', result.totals.waha], ['Nas duas', result.totals.both],
    ['Só Evolution', result.totals.onlyEvolution], ['Só WAHA', result.totals.onlyWaha]] as const : [];
  return <section className="history-comparison" aria-label="Comparar histórico">
    <p>Confere se as duas conexões estão recebendo as mesmas mensagens nas conversas recentes. Só lê; nada é alterado.</p>
    <div><button className="secondary-button" type="button" disabled={busy} onClick={() => void compare()}>{busy ? 'Comparando…' : 'Comparar histórico'}</button></div>
    {error ? <p className="connection-callout is-error" role="alert">{error}</p> : null}
    {result ? <>
      <dl className="history-comparison-stats">{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {result.skippedLidChats ? <p>{result.skippedLidChats} conversa(s) só com identificador oculto (LID) ficaram fora da comparação.</p> : null}
      {result.chats.length ? <div className="history-comparison-table"><table>
        <thead><tr><th>Conversa</th><th>Evolution</th><th>WAHA</th><th>Só Evo.</th><th>Só WAHA</th></tr></thead>
        <tbody>{result.chats.map((row) => <tr key={row.chatAddress}><td>{row.chatAddress.split('@')[0]}</td><td>{row.evolution}</td><td>{row.waha}</td><td>{row.onlyEvolution}</td><td>{row.onlyWaha}</td></tr>)}</tbody>
      </table></div> : null}
    </> : null}
  </section>;
}
