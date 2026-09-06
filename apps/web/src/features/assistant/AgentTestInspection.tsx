function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function AgentTestInspection({ debug }: { debug: Record<string, unknown> | null }) {
  if (!debug) return null;
  const media = record(debug.media);
  const output = record(debug.output);
  const actions = Array.isArray(debug.proposedActions) ? debug.proposedActions
    : Array.isArray(output.actions) ? output.actions : [];
  const notes = actions.map(record).filter((action) => action.type === "create_internal_note");
  const handoff = record(output.handoff);
  return <div aria-label="Conferência do teste">
    {typeof media.status === "string" ? <details className="agent-test-debug" open>
      <summary>{media.status === "processed" ? "O que o agente leu no arquivo" : "Não foi possível ler o arquivo"}</summary>
      <p className="muted">{typeof media.fileName === "string" ? media.fileName : "Anexo"}
        {typeof media.pages === "number" ? ` · ${media.pages} página(s)` : ""}</p>
      <pre>{typeof media.extractedText === "string" ? media.extractedText : "O agente deve pedir o reenvio ou os dados por escrito, sem adivinhar o conteúdo."}</pre>
    </details> : null}
    {handoff.required === true || notes.length > 0 ? <details className="agent-test-debug" open>
      <summary>Repasse proposto ao vendedor — não executado</summary>
      {notes.length ? notes.map((note, index) => <pre key={index}>{String(note.body ?? note.note ?? "Nota sem conteúdo.")}</pre>)
        : <p>A resposta propôs um repasse, mas não gerou uma nota de resumo. Confira antes do piloto.</p>}
      {typeof handoff.reason === "string" ? <p className="muted">Motivo: {handoff.reason}</p> : null}
    </details> : null}
  </div>;
}
