import type { CampaignAudiencePreviewDto, CampaignCadenceDto } from "../../app/api";

const reasonLabel: Record<CampaignAudiencePreviewDto["excluded"][number]["reason"], string> = {
  missing_phone: "Sem telefone válido",
  no_whatsapp: "Sem WhatsApp",
  unverified: "Ainda não verificado",
  verification_error: "Falha na verificação",
  duplicate: "Número repetido"
};

export function CampaignReview(props: {
  preview: CampaignAudiencePreviewDto;
  message: string;
  channelName: string;
  startLabel: string;
  cadence: CampaignCadenceDto;
  confirmed: boolean;
  onConfirmedChange: (checked: boolean) => void;
}) {
  const { preview } = props;
  const counts = preview.excluded.reduce<Record<string, number>>((result, item) => {
    result[item.reason] = (result[item.reason] ?? 0) + 1;
    return result;
  }, {});
  const notImported = preview.selectedCount === null ? 0 : Math.max(0,
    preview.selectedCount - preview.eligible.length - preview.excluded.length);
  return <div className="campaign-review">
    <div className="campaign-review-summary" aria-label="Resumo da audiência">
      <div><strong>{preview.selectedCount ?? "—"}</strong><span>selecionados</span></div>
      <div className="is-ready"><strong>{preview.eligible.length}</strong><span>com WhatsApp confirmado</span></div>
      <div><strong>{preview.excluded.length + notImported}</strong><span>não receberão</span></div>
    </div>
    {preview.selectedCount === null && <p className="campaign-guidance-note">
      A quantidade originalmente selecionada não está disponível neste rascunho antigo.
    </p>}
    {(Object.entries(counts).length > 0 || notImported > 0) && <div className="campaign-review-exclusions">
      <h3>Por que alguns ficaram de fora?</h3>
      <ul>{notImported > 0 && <li>{notImported} não entraram no rascunho após a importação (telefone inválido ou repetido).</li>}{Object.entries(counts).map(([reason, count]) =>
        <li key={reason}>{reasonLabel[reason as keyof typeof reasonLabel]}: {count}</li>)}</ul>
    </div>}
    <dl className="campaign-review-details">
      <div><dt>Canal de envio</dt><dd>{props.channelName}</dd></div>
      <div><dt>Início</dt><dd>{props.startLabel}</dd></div>
      <div><dt>Intervalo entre mensagens</dt><dd>{props.cadence.minDelaySeconds / 60} a {props.cadence.maxDelaySeconds / 60} minutos, sorteado a cada envio</dd></div>
      <div><dt>Pausas</dt><dd>{props.cadence.pauseMinSeconds / 60} a {props.cadence.pauseMaxSeconds / 60} minutos após cada {props.cadence.batchSize} tentativas</dd></div>
      <div><dt>Horário permitido</dt><dd>{props.cadence.windowStart} às {props.cadence.windowEnd}</dd></div>
    </dl>
    <div className="campaign-review-message"><span>Mensagem que será enviada</span><p>{props.message}</p>
      {preview.eligible[0] && <><span>Exemplo preenchido para {preview.eligible[0].name || "um contato"}</span>
        <p>{preview.eligible[0].message}</p></>}</div>
    <label className="campaign-review-confirmation">
      <input type="checkbox" checked={props.confirmed}
        onChange={(event) => props.onConfirmedChange(event.target.checked)} />
      <span>Revisei os destinatários e a mensagem. Confirmo que tenho autorização para entrar em contato com eles.</span>
    </label>
  </div>;
}
