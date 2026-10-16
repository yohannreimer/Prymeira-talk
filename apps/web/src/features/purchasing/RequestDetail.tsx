import { useCallback, useEffect, useState } from "react";
import type { PurchaseInviteDto, PurchaseRequestDetailDto } from "@prymeira-talk/shared";
import {
  AlertTriangle, ArrowLeft, Ban, CalendarClock, CheckCircle2, Clock, FilePlus2, Info, MapPin, MessageCircle, Play, Plus, Sparkles, Trophy, Truck, UserMinus, UserPlus
} from "lucide-react";
import { useTalkAuth } from "../../app/auth";
import { useOptionalTalkSession } from "../../app/session/TalkSessionProvider";
import { ComparisonTable } from "./ComparisonTable";
import { deadlineLabel, formatCep, inviteStage, money, plural, quantity, relativeTime, requestStage, shortDate } from "./format";
import type { PurchasingView } from "./PurchasingPage";
import { purchasingApi } from "./purchasing-api";
import { QuoteDrawer } from "./QuoteDrawer";
import { SupplierPickerDrawer } from "./SupplierPickerDrawer";
import { AnimatedNumber, Avatar, ConfirmButton, EmptyState, Pill, ProgressDots, Skeleton, Tabs, useToast } from "./ui";

type Tab = "suppliers" | "comparison" | "timeline";

export function openConversation(conversationId: string) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("module", "atendimento");
  url.searchParams.set("conversation", conversationId);
  window.history.pushState({ module: "atendimento", conversation: conversationId }, "", `${url.pathname}${url.search}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function RequestDetail({ requestId, go }: { requestId: string; go: (view: PurchasingView) => void }) {
  const { getToken } = useTalkAuth();
  const session = useOptionalTalkSession();
  const canApprove = session?.currentUser.role !== "agent";
  const toast = useToast();
  const [request, setRequest] = useState<PurchaseRequestDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("suppliers");
  const [busy, setBusy] = useState<string | null>(null);
  const [quoteFor, setQuoteFor] = useState<PurchaseInviteDto | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    let alive = true;
    purchasingApi.getRequest(getToken, requestId).then((detail) => {
      if (!alive) return;
      setRequest(detail);
      if (detail.needsDecision || detail.status === "approved" || detail.status === "completed") setTab("comparison");
    }).catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : "Não foi possível abrir o pedido."); });
    return () => { alive = false; };
  }, [getToken, requestId]);

  const run = useCallback(async (key: string, action: () => Promise<PurchaseRequestDetailDto>, done?: string) => {
    setBusy(key);
    try {
      const next = await action();
      setRequest(next);
      if (done) toast(done);
      return next;
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Algo deu errado.", "error");
      return null;
    } finally { setBusy(null); }
  }, [toast]);

  if (error) return <div className="po-stack"><BackLink go={go} /><div className="po-alert po-alert-error" role="alert">{error}</div></div>;
  if (!request) return <div className="po-stack"><BackLink go={go} /><div className="po-panel"><Skeleton lines={5} /></div></div>;

  const stage = requestStage(request);
  const open = ["draft", "quoting", "awaiting_approval"].includes(request.status);
  const answered = request.invites.filter((invite) => invite.quotes.length || ["declined", "replied"].includes(invite.status)).length;
  const comparison = request.comparison;
  const approve = (inviteId: string) => void run("approve", () => purchasingApi.approve(getToken, request.id, inviteId), "Compra aprovada");

  return (
    <div className="po-stack">
      <header className="po-head">
        <div className="po-head-text">
          <BackLink go={go} />
          <div className="po-title-row"><h1>{request.title}</h1><Pill pulse={request.status === "quoting" && !request.needsDecision} tone={stage.tone}>{stage.label}</Pill></div>
          <p className="po-facts">
            <span><CalendarClock size={14} aria-hidden="true" /> respostas até {shortDate(request.responseDeadline)}{open ? ` (${deadlineLabel(request.responseDeadline)})` : ""}</span>
            <span><Truck size={14} aria-hidden="true" /> entrega até {shortDate(request.deliveryDeadline)}</span>
            <span><MapPin size={14} aria-hidden="true" /> {request.deliveryCity ? `${request.deliveryCity} · ` : ""}{formatCep(request.deliveryCep)}</span>
          </p>
        </div>
        <div className="po-head-actions">
          {request.status === "draft" ? (
            <button className="po-btn po-btn-primary" disabled={busy !== null || !request.invites.length}
              onClick={() => void run("start", () => purchasingApi.startQuoting(getToken, request.id), "Cotação iniciada")} type="button">
              {busy === "start" ? <span className="po-spinner" aria-hidden="true" /> : <Play size={15} aria-hidden="true" />} Iniciar cotação
            </button>
          ) : null}
          {request.status === "approved" ? (
            <ConfirmButton busy={busy === "complete"} className="po-btn po-btn-primary" confirmLabel="Confirmar recebimento" icon={<CheckCircle2 size={15} aria-hidden="true" />}
              label="Marcar como recebido" onConfirm={() => void run("complete", () => purchasingApi.complete(getToken, request.id), "Pedido concluído")} />
          ) : null}
          {open ? (
            <ConfirmButton busy={busy === "cancel"} className="po-btn po-btn-ghost po-btn-danger" confirmLabel="Cancelar mesmo?" icon={<Ban size={15} aria-hidden="true" />}
              label="Cancelar" onConfirm={() => void run("cancel", () => purchasingApi.cancel(getToken, request.id), "Pedido cancelado")} />
          ) : null}
        </div>
      </header>

      <div className="po-summary">
        <div className="po-stat">
          <span>{request.status === "approved" || request.status === "completed" ? "Aprovado" : "Melhor proposta"}</span>
          <b>{comparison.bestTotalCents !== null ? <AnimatedNumber format={(value) => money(value)} value={request.status === "approved" || request.status === "completed"
            ? comparison.columns.find((column) => column.inviteId === request.approvedInviteId)?.totalCents ?? comparison.bestTotalCents : comparison.bestTotalCents} /> : "—"}</b>
          <small>{request.approvedSupplierName ?? (comparison.columns[0]?.totalCents !== null && comparison.columns[0] ? comparison.columns[0].supplierName : "aguardando propostas")}</small>
        </div>
        <div className={`po-stat${comparison.totalSavingsCents > 0 ? " is-good" : ""}`}>
          <span>Choradinhas economizaram</span>
          <b><AnimatedNumber format={(value) => money(value)} value={comparison.totalSavingsCents} /></b>
          <small>{comparison.columns.filter((column) => column.choradinhaDone).length} de {comparison.columns.length || 0} já responderam à choradinha</small>
        </div>
        <div className="po-stat">
          <span>Responderam</span>
          <b className="po-num">{answered} de {request.invites.length}</b>
          <small><ProgressDots done={answered} total={request.invites.length} /></small>
        </div>
        {request.budgetCeilingCents ? (
          <div className={`po-stat${comparison.bestTotalCents !== null && comparison.bestTotalCents > request.budgetCeilingCents ? " is-warn" : ""}`}>
            <span>Teto (só você vê)</span>
            <b className="po-num">{money(request.budgetCeilingCents)}</b>
            <small>{comparison.bestTotalCents === null ? "—" : comparison.bestTotalCents > request.budgetCeilingCents
              ? `melhor está ${money(comparison.bestTotalCents - request.budgetCeilingCents)} acima` : `melhor está ${money(request.budgetCeilingCents - comparison.bestTotalCents)} abaixo`}</small>
          </div>
        ) : null}
      </div>

      {request.needsDecision && canApprove && tab !== "comparison" ? (
        <div className="po-alert po-alert-decide"><Trophy size={16} aria-hidden="true" />
          <span>{comparison.recommended ? <>Tudo pronto para decidir. <b>{comparison.columns.find((column) => column.inviteId === comparison.recommended!.inviteId)?.supplierName}</b>: {comparison.recommended.reason}</> : "Todos responderam. Compare e aprove uma proposta."}</span>
          <button className="po-btn po-btn-small" onClick={() => setTab("comparison")} type="button">Ver comparativo</button>
        </div>
      ) : null}

      <Tabs label="Seções do pedido" onChange={setTab} value={tab} options={[
        { value: "suppliers", label: "Fornecedores", count: request.invites.length },
        { value: "comparison", label: "Comparativo" },
        { value: "timeline", label: "Linha do tempo" }
      ]} />

      <div className="po-tab-panel" key={tab}>
        {tab === "suppliers" ? (
          <div className="po-stack-sm">
            {!request.agentConnected && request.status === "quoting" ? (
              <div className="po-alert po-alert-info"><Info size={16} aria-hidden="true" />
                <span>Nesta versão o agente ainda não conversa sozinho: registre cada proposta e a resposta à choradinha no cartão do fornecedor.</span>
              </div>
            ) : null}
            <div className="po-items-summary">
              {request.items.map((item) => (
                <span className="po-item-chip" key={item.id} title={item.specification ?? undefined}>
                  <b className="po-num">{quantity(item.quantity)} {item.unit}</b> {item.description}
                  {item.lastPaid ? <em>última compra {money(item.lastPaid.unitPriceCents)}</em> : null}
                </span>
              ))}
            </div>
            {request.invites.length === 0 ? (
              <EmptyState icon={<UserPlus size={24} />} title="Nenhum fornecedor ainda" text="Escolha para quem a IA vai pedir orçamento."
                action={<button className="po-btn po-btn-primary" onClick={() => setPicking(true)} type="button"><Plus size={15} aria-hidden="true" /> Adicionar fornecedores</button>} />
            ) : (
              <div className="po-invite-grid">
                {request.invites.map((invite, index) => (
                  <InviteCard busy={busy} invite={invite} key={invite.id} onQuote={() => setQuoteFor(invite)} open={open} quoting={request.status !== "draft"}
                    onDecline={() => void run(`decline-${invite.id}`, () => purchasingApi.decline(getToken, request.id, invite.id, null), `${invite.supplier.name} marcado como não vai cotar`)}
                    onRemove={() => void run(`remove-${invite.id}`, () => purchasingApi.removeInvite(getToken, request.id, invite.id), `${invite.supplier.name} removido`)}
                    request={request} style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }} />
                ))}
                {open ? <button className="po-invite-add" onClick={() => setPicking(true)} type="button"><UserPlus size={18} aria-hidden="true" /> Adicionar fornecedor</button> : null}
              </div>
            )}
          </div>
        ) : null}
        {tab === "comparison" ? (
          <ComparisonTable busy={busy === "approve"} canApprove={canApprove && ["quoting", "awaiting_approval"].includes(request.status)} onApprove={approve}
            onQuote={(inviteId) => setQuoteFor(request.invites.find((invite) => invite.id === inviteId) ?? null)} request={request} />
        ) : null}
        {tab === "timeline" ? <Timeline request={request} /> : null}
      </div>

      {quoteFor ? (
        <QuoteDrawer invite={quoteFor} onClose={() => setQuoteFor(null)} request={request}
          onSave={async (input) => {
            const next = await run("quote", () => purchasingApi.recordQuote(getToken, request.id, quoteFor.id, input), input.kind === "choradinha" ? "Choradinha registrada" : "Proposta registrada");
            if (next) setQuoteFor(null);
          }} saving={busy === "quote"} />
      ) : null}
      {picking ? (
        <SupplierPickerDrawer exclude={new Set(request.invites.map((invite) => invite.supplier.id))} onClose={() => setPicking(false)} saving={busy === "add"}
          onSave={async (ids) => {
            const next = await run("add", () => purchasingApi.addSuppliers(getToken, request.id, ids), ids.length === 1 ? "Fornecedor adicionado" : `${ids.length} fornecedores adicionados`);
            if (next) setPicking(false);
          }} />
      ) : null}
    </div>
  );
}

function BackLink({ go }: { go: (view: PurchasingView) => void }) {
  return <button className="po-back" onClick={() => go({ kind: "list" })} type="button"><ArrowLeft size={15} aria-hidden="true" /> Orçamentos</button>;
}

function InviteCard({ invite, request, onQuote, onDecline, onRemove, busy, open, quoting, style }: {
  invite: PurchaseInviteDto; request: PurchaseRequestDetailDto; onQuote: () => void; onDecline: () => void; onRemove: () => void;
  busy: string | null; open: boolean; quoting: boolean; style: React.CSSProperties;
}) {
  const column = request.comparison.columns.find((candidate) => candidate.inviteId === invite.id);
  const stage = inviteStage[invite.status];
  const isRecommended = request.comparison.recommended?.inviteId === invite.id;
  const latest = invite.quotes.at(-1);
  return (
    <article className={`po-invite${invite.status === "winner" ? " is-winner" : ""}${invite.status === "declined" || invite.status === "lost" ? " is-muted" : ""}`} style={style}>
      <header>
        <Avatar name={invite.supplier.name} size={36} />
        <div className="po-invite-name">
          <b>{invite.supplier.name}</b>
          <span>{invite.supplier.contactName ?? invite.supplier.city ?? "—"}</span>
        </div>
        <Pill tone={stage.tone}>{invite.status === "winner" ? <Trophy size={11} aria-hidden="true" /> : null}{stage.label}</Pill>
      </header>

      {column && column.totalCents !== null ? (
        <div className="po-invite-price">
          {column.savingsCents > 0 ? <span className="po-strike po-num">{money(column.firstTotalCents)}</span> : null}
          <b className="po-num">{money(column.totalCents)}</b>
          {column.savingsCents > 0 ? <span className="po-save-chip"><Sparkles size={11} aria-hidden="true" /> −{column.savingsPercent.toLocaleString("pt-BR")}%</span> : null}
          {isRecommended ? <span className="po-reco-chip">★ recomendado</span> : null}
        </div>
      ) : latest ? (
        <div className="po-invite-price is-partial"><span>Proposta incompleta</span><small>falta {column?.missing.join(", ")}</small></div>
      ) : (
        <div className="po-invite-price is-empty">
          <span>{invite.status === "declined" ? invite.declinedReason ?? "Não trabalha com esses itens." : quoting ? "Aguardando proposta" : "Recebe o pedido quando a cotação começar"}</span>
        </div>
      )}

      {column && column.totalCents !== null ? (
        <ul className="po-invite-facts">
          <li><Truck size={13} aria-hidden="true" /> {column.freightCents === 0 ? "frete grátis" : `frete ${money(column.freightCents)}`}</li>
          <li className={column.deliveryLate ? "is-warn" : ""}><CalendarClock size={13} aria-hidden="true" /> {column.deliveryDate ? `entrega ${shortDate(column.deliveryDate)}` : column.deliveryText ?? "—"}{column.deliveryLate ? " · depois do limite" : ""}</li>
          {column.paymentTerms ? <li>{column.paymentTerms}</li> : null}
          {!column.choradinhaDone && open ? <li className="po-hint-violet"><Sparkles size={13} aria-hidden="true" /> falta a choradinha</li> : null}
        </ul>
      ) : null}

      <footer>
        {invite.lastReplyAt ? <span className="po-muted po-small"><Clock size={12} aria-hidden="true" /> {relativeTime(invite.lastReplyAt)}</span> : <span />}
        <span className="po-grow" />
        {invite.conversationId ? <button className="po-btn po-btn-small po-btn-ghost" onClick={() => openConversation(invite.conversationId!)} type="button"><MessageCircle size={14} aria-hidden="true" /> Conversa</button> : null}
        {open && quoting && invite.status !== "declined" ? (
          <button className="po-btn po-btn-small" onClick={onQuote} type="button"><FilePlus2 size={14} aria-hidden="true" /> {latest ? (column?.choradinhaDone ? "Atualizar" : "Choradinha") : "Registrar proposta"}</button>
        ) : null}
        {open && quoting && !latest && invite.status !== "declined" ? (
          <ConfirmButton busy={busy === `decline-${invite.id}`} className="po-btn po-btn-small po-btn-ghost" confirmLabel="Confirmar" label="Não vai cotar" onConfirm={onDecline} />
        ) : null}
        {open && !quoting ? (
          <button aria-label={`Remover ${invite.supplier.name}`} className="po-icon-btn" disabled={busy === `remove-${invite.id}`} onClick={onRemove} type="button"><UserMinus size={15} /></button>
        ) : null}
      </footer>
    </article>
  );
}

const EVENT_ICON: Record<string, typeof Info> = {
  created: FilePlus2, quoting_started: Play, quote_initial: FilePlus2, quote_choradinha: Sparkles, quote_counter: Sparkles, quote_correction: FilePlus2,
  supplier_declined: UserMinus, suppliers_added: UserPlus, supplier_removed: UserMinus, approved: Trophy, canceled: Ban, completed: CheckCircle2
};

function Timeline({ request }: { request: PurchaseRequestDetailDto }) {
  if (!request.events.length) return <p className="po-muted">Nada aconteceu ainda.</p>;
  return (
    <ol className="po-timeline">
      {request.events.map((event) => {
        const Icon = EVENT_ICON[event.type] ?? AlertTriangle;
        return (
          <li className={`po-tl-${event.type.startsWith("quote_choradinha") ? "violet" : event.type === "approved" ? "blue" : event.type === "canceled" ? "red" : "green"}`} key={event.id}>
            <span className="po-tl-icon"><Icon size={14} aria-hidden="true" /></span>
            <div>
              <p>{event.summary}</p>
              {event.reason ? <p className="po-tl-reason">{event.reason}</p> : null}
              <time dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString("pt-BR")}>{relativeTime(event.createdAt)}</time>
            </div>
          </li>
        );
      })}
      <li className="po-tl-end"><span className="po-muted po-small">{plural(request.items.length, "item", "itens")} · criado em {new Date(request.createdAt).toLocaleDateString("pt-BR")}</span></li>
    </ol>
  );
}
