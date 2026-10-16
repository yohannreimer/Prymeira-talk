import { useState } from "react";
import type { ComparisonColumn, PurchaseRequestDetailDto } from "@prymeira-talk/shared";
import { AlertTriangle, Check, FilePlus2, Sparkles, Star, Trophy } from "lucide-react";
import { money, quantity, shortDate } from "./format";
import { ConfirmButton, EmptyState } from "./ui";

/** The mapa de cotação: items down, suppliers across, the choradinha shown as "before → after" in every cell. */
export function ComparisonTable({ request, canApprove, onApprove, onQuote, busy }: {
  request: PurchaseRequestDetailDto; canApprove: boolean; onApprove: (inviteId: string) => void; onQuote: (inviteId: string) => void; busy: boolean;
}) {
  const [hoverCol, setHoverCol] = useState<string | null>(null);
  const [origin, setOrigin] = useState<{ inviteId: string; text: string } | null>(null);
  const { comparison, items } = request;
  const columns = comparison.columns.filter((column) => column.status !== "declined");
  if (!columns.length) {
    return <EmptyState icon={<FilePlus2 size={24} />} title="Nenhuma proposta ainda" text="Assim que a primeira proposta for registrada, o comparativo aparece aqui com o melhor preço destacado." />;
  }
  const recommended = comparison.recommended?.inviteId;
  const approvedId = request.approvedInviteId;
  const max = Math.max(...columns.map((column) => column.firstTotalCents ?? column.totalCents ?? 0));
  const originOf = (inviteId: string) => request.invites.find((invite) => invite.id === inviteId)?.quotes.at(-1)?.origin ?? null;
  const cellProps = (column: ComparisonColumn) => ({
    className: [column.inviteId === hoverCol ? "is-hover" : "", column.inviteId === (approvedId ?? recommended) ? "is-pick" : ""].filter(Boolean).join(" "),
    onMouseEnter: () => setHoverCol(column.inviteId), onMouseLeave: () => setHoverCol(null)
  });

  return (
    <div className="po-stack-sm">
      {comparison.recommended && !approvedId ? (
        <div className="po-reco">
          <Star size={16} aria-hidden="true" />
          <span><b>Recomendado: {columns.find((column) => column.inviteId === recommended)?.supplierName}.</b> {comparison.recommended.reason}</span>
        </div>
      ) : null}

      <div className="po-bars" aria-label="Total antes e depois da choradinha">
        {columns.filter((column) => column.totalCents !== null).map((column) => (
          <div key={column.inviteId} {...cellProps(column)} className={`po-bar-row ${cellProps(column).className}`}>
            <span className="po-bar-name">{column.supplierName}</span>
            <span className="po-bar-track">
              {column.savingsCents > 0 ? <span className="po-bar-before" style={{ width: `${((column.firstTotalCents ?? 0) / max) * 100}%` }} /> : null}
              <span className="po-bar-now" style={{ width: `${((column.totalCents ?? 0) / max) * 100}%` }} />
            </span>
            <span className="po-bar-value po-num">{money(column.totalCents, { compact: true })}{column.savingsCents > 0 ? <em>−{money(column.savingsCents, { compact: true })}</em> : null}</span>
          </div>
        ))}
        <div className="po-bar-legend"><span><i className="po-legend-before" /> proposta inicial</span><span><i className="po-legend-now" /> depois da choradinha</span></div>
      </div>

      <div className="po-table-wrap">
        <table className="po-map">
          <thead>
            <tr>
              <th scope="col"><span className="po-sr">Item</span></th>
              {columns.map((column) => (
                <th key={column.inviteId} scope="col" {...cellProps(column)}>
                  <span className="po-map-supplier">
                    {column.inviteId === approvedId ? <Trophy size={13} aria-label="aprovado" /> : column.inviteId === recommended ? <Star size={13} aria-label="recomendado" /> : null}
                    {column.supplierName}
                  </span>
                  {column.choradinhaDone ? <span className="po-map-tag"><Sparkles size={10} aria-hidden="true" /> choradinha</span> : <span className="po-map-tag is-pending">sem choradinha</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <th scope="row">
                  <span className="po-map-item">{item.description}</span>
                  <span className="po-map-qty">{quantity(item.quantity)} {item.unit}{item.lastPaid ? ` · última ${money(item.lastPaid.unitPriceCents)}` : ""}</span>
                </th>
                {columns.map((column) => {
                  const line = column.lines[item.id];
                  const best = comparison.bestPerItem[item.id] === column.inviteId;
                  const props = cellProps(column);
                  return (
                    <td key={column.inviteId} {...props} className={`${props.className}${best ? " is-best" : ""}`}>
                      {line ? (
                        <button className="po-cell-btn" onClick={() => {
                          const text = originOf(column.inviteId);
                          setOrigin(text ? (origin?.inviteId === column.inviteId ? null : { inviteId: column.inviteId, text }) : null);
                        }} title="Ver de onde veio esse preço" type="button">
                          {line.firstUnitPriceCents !== null ? <span className="po-strike">{money(line.firstUnitPriceCents)}</span> : null}
                          <span className="po-num">{money(line.unitPriceCents)}</span>
                          {best ? <Check className="po-best-icon" size={13} aria-label="menor preço" /> : null}
                        </button>
                      ) : <span className="po-muted">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
            <Row columns={columns} label="Frete" cellProps={cellProps} render={(column) => column.freightCents === null ? <span className="po-muted">não informado</span> : column.freightCents === 0 ? "grátis" : money(column.freightCents)} />
            <Row columns={columns} label="Entrega" cellProps={cellProps} render={(column) => (
              <span className={column.deliveryLate ? "po-warn-text" : ""}>{column.deliveryDate ? shortDate(column.deliveryDate) : column.deliveryText ?? <span className="po-muted">—</span>}{column.deliveryLate ? <AlertTriangle size={12} aria-label="depois da data limite" /> : null}</span>
            )} />
            <Row columns={columns} label="Pagamento" cellProps={cellProps} render={(column) => column.paymentTerms ?? <span className="po-muted">—</span>} />
            <Row columns={columns} label="Válida até" cellProps={cellProps} render={(column) => (
              <span className={column.expired ? "po-danger-text" : column.expiresSoon ? "po-warn-text" : ""}>{column.validUntil ? shortDate(column.validUntil) : <span className="po-muted">—</span>}{column.expired ? " · vencida" : column.expiresSoon ? " · vence logo" : ""}</span>
            )} />
          </tbody>
          <tfoot>
            <tr className="po-map-total">
              <th scope="row">Total com frete</th>
              {columns.map((column) => {
                const props = cellProps(column);
                return (
                  <td key={column.inviteId} {...props}>
                    {column.totalCents !== null ? (
                      <>
                        {column.savingsCents > 0 ? <span className="po-strike">{money(column.firstTotalCents)}</span> : null}
                        <b className="po-num">{money(column.totalCents)}</b>
                        {column.savingsCents > 0 ? <span className="po-save-chip">−{column.savingsPercent.toLocaleString("pt-BR")}%</span> : null}
                      </>
                    ) : <span className="po-muted po-small">falta {column.missing.join(", ")}</span>}
                  </td>
                );
              })}
            </tr>
            <tr className="po-map-actions">
              <th scope="row" />
              {columns.map((column) => {
                const props = cellProps(column);
                return (
                  <td key={column.inviteId} {...props}>
                    {column.inviteId === approvedId ? <span className="po-approved"><Trophy size={14} aria-hidden="true" /> Aprovado</span>
                      : canApprove && column.totalCents !== null ? (
                        <ConfirmButton busy={busy} className={`po-btn po-btn-small${column.inviteId === recommended ? " po-btn-primary" : ""}`}
                          confirmLabel={`Aprovar ${money(column.totalCents, { compact: true })}?`} label="Aprovar" onConfirm={() => onApprove(column.inviteId)} />
                      ) : !approvedId && column.totalCents === null ? (
                        <button className="po-btn po-btn-small po-btn-ghost" onClick={() => onQuote(column.inviteId)} type="button">Completar</button>
                      ) : null}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      {origin ? (
        <div className="po-origin" role="note">
          <span className="po-eyebrow">De onde veio · {columns.find((column) => column.inviteId === origin.inviteId)?.supplierName}</span>
          <blockquote>{origin.text}</blockquote>
        </div>
      ) : <p className="po-muted po-small">Clique num preço para ver a mensagem de onde ele veio. A aprovação é sempre sua; a IA nunca fecha a compra sozinha.</p>}
    </div>
  );
}

function Row({ columns, label, render, cellProps }: {
  columns: ComparisonColumn[]; label: string; render: (column: ComparisonColumn) => React.ReactNode;
  cellProps: (column: ComparisonColumn) => { className: string; onMouseEnter: () => void; onMouseLeave: () => void };
}) {
  return (
    <tr className="po-map-meta">
      <th scope="row">{label}</th>
      {columns.map((column) => <td key={column.inviteId} {...cellProps(column)}>{render(column)}</td>)}
    </tr>
  );
}
