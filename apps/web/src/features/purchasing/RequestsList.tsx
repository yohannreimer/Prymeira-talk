import { useEffect, useMemo, useState } from "react";
import type { PurchaseRequestSummaryDto } from "@prymeira-talk/shared";
import { ArrowRight, CalendarClock, Plus, ShoppingCart, Sparkles, Truck } from "lucide-react";
import { useTalkAuth } from "../../app/auth";
import { daysUntil, deadlineLabel, money, plural, requestStage, shortDate } from "./format";
import type { PurchasingView } from "./PurchasingPage";
import { purchasingApi } from "./purchasing-api";
import { AnimatedNumber, EmptyState, Pill, ProgressDots, Skeleton, Tabs } from "./ui";

type Filter = "all" | "quoting" | "you" | "done";

function matches(request: PurchaseRequestSummaryDto, filter: Filter) {
  if (filter === "quoting") return (request.status === "quoting" || request.status === "draft") && !request.needsDecision;
  if (filter === "you") return request.needsDecision;
  if (filter === "done") return ["approved", "completed", "canceled"].includes(request.status);
  return true;
}

export function RequestsList({ go }: { go: (view: PurchasingView) => void }) {
  const { getToken } = useTalkAuth();
  const [requests, setRequests] = useState<PurchaseRequestSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let alive = true;
    purchasingApi.listRequests(getToken).then((rows) => { if (alive) setRequests(rows); })
      .catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : "Não foi possível carregar os pedidos."); });
    return () => { alive = false; };
  }, [getToken]);

  const counts = useMemo(() => ({
    quoting: requests?.filter((request) => matches(request, "quoting")).length ?? 0,
    you: requests?.filter((request) => matches(request, "you")).length ?? 0
  }), [requests]);
  const totalSavings = requests?.reduce((sum, request) => sum + (request.status === "canceled" ? 0 : request.savingsCents), 0) ?? 0;
  const visible = requests?.filter((request) => matches(request, filter)) ?? [];

  return (
    <div className="po-stack">
      <header className="po-head">
        <div>
          <h1>Orçamentos</h1>
          <p>A IA pede orçamento aos seus fornecedores, cobra quem não respondeu e sempre pede um desconto antes de te mostrar.</p>
        </div>
        <div className="po-head-actions">
          {totalSavings > 0 ? (
            <div className="po-savings-badge" title="Soma do que as choradinhas tiraram das propostas">
              <Sparkles size={15} aria-hidden="true" />
              <span>Economia com choradinhas</span>
              <b><AnimatedNumber format={(value) => money(value, { compact: true })} value={totalSavings} /></b>
            </div>
          ) : null}
          <button className="po-btn po-btn-primary" onClick={() => go({ kind: "new" })} type="button"><Plus size={16} aria-hidden="true" /> Novo pedido</button>
        </div>
      </header>

      <Tabs label="Filtrar pedidos" onChange={setFilter} value={filter} options={[
        { value: "all", label: "Todos" },
        { value: "quoting", label: "Cotando", count: counts.quoting },
        { value: "you", label: "Aguardando você", count: counts.you },
        { value: "done", label: "Concluídos" }
      ]} />

      {error ? <div className="po-alert po-alert-error" role="alert">{error}</div> : null}
      {!requests && !error ? <div className="po-card-list">{[0, 1, 2].map((index) => <div className="po-request-card is-loading" key={index}><Skeleton lines={2} /></div>)}</div> : null}

      {requests && requests.length === 0 ? (
        <EmptyState icon={<ShoppingCart size={26} />} title="Seu primeiro pedido de orçamento"
          text="Diga o que precisa comprar, escolha os fornecedores e acompanhe as propostas chegando num quadro só."
          action={<button className="po-btn po-btn-primary" onClick={() => go({ kind: "new" })} type="button"><Plus size={16} aria-hidden="true" /> Criar pedido</button>} />
      ) : null}

      {requests && requests.length > 0 && visible.length === 0 ? <p className="po-muted po-center">Nenhum pedido neste filtro.</p> : null}

      <div className="po-card-list">
        {visible.map((request, index) => {
          const stage = requestStage(request);
          const open = request.status === "quoting" || request.status === "draft";
          return (
            <button className={`po-request-card${request.needsDecision ? " needs-you" : ""}`} key={request.id} onClick={() => go({ kind: "request", id: request.id })}
              style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }} type="button">
              <div className="po-request-top">
                <span className="po-request-title">{request.title}</span>
                <Pill pulse={request.status === "quoting" && !request.needsDecision} tone={stage.tone}>{stage.label}</Pill>
                <span className="po-grow" />
                {request.invited > 0 ? (
                  <span className="po-progress"><ProgressDots done={request.answered} total={request.invited} /><span>{request.answered} de {request.invited}</span></span>
                ) : <span className="po-muted">sem fornecedores</span>}
              </div>
              <div className="po-request-bottom">
                {request.approvedSupplierName ? (
                  <span>Aprovado: <b>{request.approvedSupplierName}</b>{request.bestTotalCents !== null ? <> · {money(request.bestTotalCents)}</> : null}</span>
                ) : request.bestTotalCents !== null ? (
                  <span>Melhor até agora: <b className="po-num">{money(request.bestTotalCents)}</b></span>
                ) : <span className="po-muted">{plural(request.itemCount, "item", "itens")} · aguardando propostas</span>}
                {request.savingsCents > 0 ? <span className="po-save-chip">−{money(request.savingsCents, { compact: true })} na choradinha</span> : null}
                <span className="po-grow" />
                {open ? (
                  <span className={`po-meta${daysUntil(request.responseDeadline) <= 1 ? " is-warn" : ""}`} title={deadlineLabel(request.responseDeadline)}>
                    <CalendarClock size={13} aria-hidden="true" /> respostas até {shortDate(request.responseDeadline)}
                  </span>
                ) : null}
                <span className="po-meta"><Truck size={13} aria-hidden="true" /> entrega até {shortDate(request.deliveryDeadline)}</span>
                {request.needsDecision ? <span className="po-cta">Comparar e aprovar <ArrowRight size={14} aria-hidden="true" /></span> : <ArrowRight className="po-card-arrow" size={16} aria-hidden="true" />}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
