import { useMemo, useState } from "react";
import type { PurchaseInviteDto, PurchaseQuoteInput, PurchaseQuoteKind, PurchaseRequestDetailDto } from "@prymeira-talk/shared";
import { Check, Sparkles } from "lucide-react";
import { money, moneyInputValue, parseMoney, quantity } from "./format";
import { Drawer, Field } from "./ui";

const KINDS: Array<{ value: PurchaseQuoteKind; label: string; hint: string }> = [
  { value: "initial", label: "Proposta", hint: "O primeiro orçamento do fornecedor." },
  { value: "choradinha", label: "Resposta à choradinha", hint: "O preço depois de pedir uma melhora." },
  { value: "correction", label: "Correção", hint: "Ajuste num número (ex.: esqueceu o frete)." }
];

/** Register (or update) a supplier's quote by hand. Each save is a new version, so the before/after stays visible. */
export function QuoteDrawer({ request, invite, onClose, onSave, saving }: {
  request: PurchaseRequestDetailDto; invite: PurchaseInviteDto; onClose: () => void; onSave: (input: PurchaseQuoteInput) => Promise<void>; saving: boolean;
}) {
  const latest = invite.quotes.at(-1);
  const hasChoradinha = invite.quotes.some((quote) => quote.kind === "choradinha");
  const [kind, setKind] = useState<PurchaseQuoteKind>(!latest ? "initial" : hasChoradinha ? "correction" : "choradinha");
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(request.items.map((item) => [item.id, moneyInputValue(latest?.lines.find((line) => line.itemId === item.id)?.unitPriceCents)])));
  const [freight, setFreight] = useState(latest?.freightCents === 0 ? "0" : moneyInputValue(latest?.freightCents));
  const [freeFreight, setFreeFreight] = useState(latest?.freightCents === 0);
  const [deliveryDate, setDeliveryDate] = useState(latest?.deliveryDate ?? "");
  const [deliveryText, setDeliveryText] = useState(latest?.deliveryText ?? "");
  const [payment, setPayment] = useState(latest?.paymentTerms ?? "");
  const [validUntil, setValidUntil] = useState(latest?.validUntil ?? "");
  const [origin, setOrigin] = useState("");
  const [tried, setTried] = useState(false);

  const parsed = useMemo(() => request.items.map((item) => ({ item, cents: prices[item.id]?.trim() ? parseMoney(prices[item.id]!) : null })), [prices, request.items]);
  const freightCents = freeFreight ? 0 : freight.trim() ? parseMoney(freight) : null;
  const total = parsed.every((row) => row.cents !== null)
    ? parsed.reduce((sum, row) => sum + Math.round(row.cents! * row.item.quantity), 0) + (freightCents ?? 0) : null;
  const before = latest?.totalCents ?? null;
  const invalid = parsed.some((row) => prices[row.item.id]?.trim() && row.cents === null) || (!freeFreight && freight.trim() !== "" && freightCents === null);
  const empty = parsed.every((row) => row.cents === null);

  async function save() {
    if (invalid || empty) { setTried(true); return; }
    await onSave({
      kind,
      lines: parsed.filter((row) => row.cents !== null).map((row) => ({ itemId: row.item.id, unitPriceCents: row.cents! })),
      freightCents, deliveryDate: deliveryDate || null, deliveryText: deliveryText.trim() || null, paymentTerms: payment.trim() || null,
      validUntil: validUntil || null, origin: origin.trim() || null
    });
  }

  return (
    <Drawer onClose={onClose} title={invite.supplier.name} subtitle={latest ? `Versão ${latest.version + 1} da proposta` : "Primeira proposta"}
      footer={
        <>
          <div className="po-drawer-total">
            <span>Total com frete</span>
            <b className="po-num">{total !== null ? money(total) : "—"}</b>
            {before !== null && total !== null && total !== before ? (
              <span className={total < before ? "po-save-chip" : "po-up-chip"}>{total < before ? "−" : "+"}{money(Math.abs(before - total))}</span>
            ) : null}
          </div>
          <button className="po-btn po-btn-ghost" onClick={onClose} type="button">Cancelar</button>
          <button className="po-btn po-btn-primary" disabled={saving} onClick={() => void save()} type="button">
            {saving ? <span className="po-spinner" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />} Salvar
          </button>
        </>
      }>
      <div className="po-form">
        <div className="po-segment" role="radiogroup" aria-label="Tipo de registro">
          {KINDS.map((option) => (
            <button aria-checked={kind === option.value} className={kind === option.value ? "is-on" : ""} disabled={option.value !== "initial" && !latest}
              key={option.value} onClick={() => setKind(option.value)} role="radio" type="button">
              {option.value === "choradinha" ? <Sparkles size={13} aria-hidden="true" /> : null}{option.label}
            </button>
          ))}
        </div>
        <p className="po-muted po-small">{KINDS.find((option) => option.value === kind)?.hint}</p>

        <div className="po-price-list">
          {parsed.map(({ item, cents }) => {
            const previous = latest?.lines.find((line) => line.itemId === item.id)?.unitPriceCents;
            const bad = Boolean(prices[item.id]?.trim()) && cents === null;
            return (
              <div className={`po-price-row${bad ? " has-error" : ""}`} key={item.id}>
                <div>
                  <b>{item.description}</b>
                  <span className="po-muted po-small">{quantity(item.quantity)} {item.unit}{item.lastPaid ? ` · última compra ${money(item.lastPaid.unitPriceCents)}` : ""}</span>
                </div>
                <div className="po-money-input">
                  <span>R$</span>
                  <input aria-label={`Preço por ${item.unit} de ${item.description}`} inputMode="decimal"
                    onBlur={() => { if (cents !== null) setPrices({ ...prices, [item.id]: moneyInputValue(cents) }); }}
                    onChange={(event) => setPrices({ ...prices, [item.id]: event.target.value })} placeholder="0,00" value={prices[item.id] ?? ""} />
                  <small>/{item.unit}</small>
                </div>
                {previous !== undefined && cents !== null && cents !== previous ? (
                  <span className={cents < previous ? "po-delta is-down" : "po-delta is-up"}>{cents < previous ? "↓" : "↑"} {money(Math.abs(previous - cents))}</span>
                ) : <span />}
              </div>
            );
          })}
        </div>

        <div className="po-grid-2">
          <Field label="Frete" htmlFor="po-freight">
            <div className="po-money-input">
              <span>R$</span>
              <input disabled={freeFreight} id="po-freight" inputMode="decimal" onChange={(event) => setFreight(event.target.value)} placeholder="não informado" value={freeFreight ? "0" : freight} />
            </div>
            <label className="po-inline-check"><input checked={freeFreight} onChange={(event) => setFreeFreight(event.target.checked)} type="checkbox" /> Frete grátis</label>
          </Field>
          <Field label="Pagamento" htmlFor="po-payment">
            <input id="po-payment" onChange={(event) => setPayment(event.target.value)} placeholder="PIX, 28/56, boleto 30 dias…" value={payment} />
          </Field>
        </div>
        <div className="po-grid-2">
          <Field label="Entrega em" hint={deliveryDate && deliveryDate > request.deliveryDeadline ? undefined : "Data em que o fornecedor entrega."}
            error={deliveryDate && deliveryDate > request.deliveryDeadline ? "Depois da data limite do pedido." : null} htmlFor="po-delivery-date">
            <input id="po-delivery-date" onChange={(event) => setDeliveryDate(event.target.value)} type="date" value={deliveryDate} />
            <input aria-label="Prazo em texto" className="po-mt" onChange={(event) => setDeliveryText(event.target.value)} placeholder="ou em texto: 10 dias úteis" value={deliveryText} />
          </Field>
          <Field label="Proposta válida até" htmlFor="po-valid">
            <input id="po-valid" onChange={(event) => setValidUntil(event.target.value)} type="date" value={validUntil} />
          </Field>
        </div>
        <Field label="De onde veio (opcional)" hint="Cole a mensagem do fornecedor. Aparece ao clicar no preço no comparativo." htmlFor="po-origin">
          <textarea id="po-origin" onChange={(event) => setOrigin(event.target.value)} placeholder="“Faço R$ 845 a unidade pra fechar, frete R$ 350.”" rows={3} value={origin} />
        </Field>
        {tried && (invalid || empty) ? <div className="po-alert po-alert-warn" role="alert">{empty ? "Informe o preço de pelo menos um item." : "Algum valor não é um número válido."}</div> : null}
      </div>
    </Drawer>
  );
}
