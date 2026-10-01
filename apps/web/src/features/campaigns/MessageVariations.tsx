import { missingPlaceholders } from "./message-variations";

export function MessageVariations(props: {
  message: string;
  variations: string[];
  busy: boolean;
  error: string | null;
  onGenerate: () => void;
  onChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
}) {
  const hasVariations = props.variations.length > 0;
  return <section className="message-variations" aria-label="Variações da mensagem">
    <div className="message-variations-heading">
      <strong>Variações ({props.variations.length} de 5)</strong>
      <button type="button" className="secondary-button" onClick={props.onGenerate}
        disabled={props.busy || !props.message.trim()}>
        {props.busy ? "Gerando..." : hasVariations ? "Regerar variações" : "Gerar 5 variações"}
      </button>
    </div>
    <p className="campaign-guidance-note">
      Cada destinatário recebe uma das mensagens, alternadas. Textos diferentes reduzem o risco de bloqueio. Revise antes de salvar.
    </p>
    {props.error && <p role="alert" className="error-note">{props.error}</p>}
    {props.variations.map((text, index) => {
      const missing = missingPlaceholders(props.message, text);
      return <div className="message-variation" key={index}>
        <label className="form-field"><span>Variação {index + 1}</span>
          <textarea rows={4} value={text} maxLength={2000}
            onChange={(event) => props.onChange(index, event.target.value)} /></label>
        {missing.length > 0 && <p role="alert" className="error-note">
          Falta o campo {missing.map((key) => `{{${key}}}`).join(", ")} nesta variação.</p>}
        <button type="button" className="secondary-button" onClick={() => props.onRemove(index)}>Remover</button>
      </div>;
    })}
  </section>;
}
