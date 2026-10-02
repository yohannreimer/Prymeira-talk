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
  return <section className="context-card" aria-label="Comparar histórico">
    <div className="context-card-title">Histórico: Evolution × WAHA</div>
    <p className="list-note">Compara as conversas recentes nas duas conexões, mensagem por mensagem. Só lê; nada é importado.</p>
    <button className="secondary-button" type="button" disabled={busy} onClick={() => void compare()}>{busy ? 'Comparando…' : 'Comparar histórico'}</button>
    {error ? <p className="error-note" role="alert">{error}</p> : null}
    {result ? <>
      <p>Evolution: {result.totals.evolution} · WAHA: {result.totals.waha} · nas duas: {result.totals.both} · só Evolution: {result.totals.onlyEvolution} · só WAHA: {result.totals.onlyWaha}</p>
      {result.skippedLidChats ? <p className="list-note">{result.skippedLidChats} conversa(s) só com identificador oculto (LID) ficaram fora da comparação.</p> : null}
      <table className="list-note"><thead><tr><th>Conversa</th><th>Evolution</th><th>WAHA</th><th>Só Evolution</th><th>Só WAHA</th></tr></thead>
        <tbody>{result.chats.map((row) => <tr key={row.chatAddress}><td>{row.chatAddress.split('@')[0]}</td><td>{row.evolution}</td><td>{row.waha}</td><td>{row.onlyEvolution}</td><td>{row.onlyWaha}</td></tr>)}</tbody>
      </table>
    </> : null}
  </section>;
}
