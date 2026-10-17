import { useState } from "react";
import type { PurchaseRequestDetailDto, PurchaseStartInput } from "@prymeira-talk/shared";
import { Bot, ClipboardList, Play } from "lucide-react";
import { plural } from "./format";
import { Drawer, Field } from "./ui";

/** How the quote starts: the agent asks every supplier on WhatsApp (reviewed or on its own), or quotes are typed in by hand. */
export function StartQuotingDrawer({ request, onClose, onStart, saving }: {
  request: PurchaseRequestDetailDto; onClose: () => void; onStart: (input: PurchaseStartInput) => Promise<void>; saving: boolean;
}) {
  const channels = request.agentChannels;
  const [way, setWay] = useState<"agent" | "manual">(channels.length ? "agent" : "manual");
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [review, setReview] = useState(true);
  const suppliers = plural(request.invites.length, "fornecedor", "fornecedores");

  return (
    <Drawer onClose={onClose} title="Iniciar cotação" subtitle={`${suppliers} neste pedido`}
      footer={
        <>
          <span className="po-grow" />
          <button className="po-btn po-btn-ghost" onClick={onClose} type="button">Cancelar</button>
          <button className="po-btn po-btn-primary" disabled={saving || (way === "agent" && !channelId)} type="button"
            onClick={() => void onStart(way === "agent" ? { agent: { mode: review ? "review" : "auto", channelId } } : {})}>
            {saving ? <span className="po-spinner" aria-hidden="true" /> : <Play size={15} aria-hidden="true" />} Iniciar
          </button>
        </>
      }>
      <div className="po-stack-sm">
        <div className="po-start-options" role="radiogroup" aria-label="Como pedir os orçamentos">
          <button aria-checked={way === "agent"} className={`po-start-option${way === "agent" ? " is-on" : ""}`} disabled={!channels.length}
            onClick={() => setWay("agent")} role="radio" type="button">
            <Bot size={18} aria-hidden="true" />
            <span><b>O agente pede no WhatsApp</b><small>Ele manda o pedido, lê as propostas, cobra quem não respondeu e faz a choradinha.</small></span>
          </button>
          <button aria-checked={way === "manual"} className={`po-start-option${way === "manual" ? " is-on" : ""}`}
            onClick={() => setWay("manual")} role="radio" type="button">
            <ClipboardList size={18} aria-hidden="true" />
            <span><b>Registro à mão</b><small>Você conversa com os fornecedores e registra cada proposta no cartão.</small></span>
          </button>
        </div>
        {!channels.length ? <p className="po-muted po-small">Nenhum número conectado pelo QR Code pode iniciar conversas, então só o registro à mão está disponível.</p> : null}
        {way === "agent" ? (
          <>
            <Field label="Número que vai pedir" htmlFor="po-start-channel" hint="As respostas dos fornecedores ficam com o agente comprador, não com o agente de vendas.">
              <select id="po-start-channel" onChange={(event) => setChannelId(event.target.value)} value={channelId}>
                {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
              </select>
            </Field>
            <label className="po-switch">
              <input checked={review} onChange={(event) => setReview(event.target.checked)} type="checkbox" />
              <span className="po-switch-track" aria-hidden="true"><span /></span>
              <span>Conferir cada mensagem antes de enviar</span>
            </label>
            <p className="po-muted po-small">{review
              ? "O agente escreve e a mensagem espera no cartão do fornecedor até você enviar, editar ou descartar."
              : "O agente envia sozinho. Cobranças só em dia útil, das 8h às 18h. Quem fecha a compra é sempre você."}</p>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
