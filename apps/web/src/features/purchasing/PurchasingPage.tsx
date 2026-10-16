import { useCallback, useEffect, useState } from "react";
import { ClipboardList, Store } from "lucide-react";
import { NewRequestWizard } from "./NewRequestWizard";
import { RequestDetail } from "./RequestDetail";
import { RequestsList } from "./RequestsList";
import { SuppliersPage } from "./SuppliersPage";
import { ToastProvider } from "./ui";
import "./purchasing.css";

/** Where the module is, kept in the URL so back/forward and shared links work: ?module=orcamentos&pedido=<id> | &ver=novo | &ver=fornecedores. */
export type PurchasingView = { kind: "list" } | { kind: "new" } | { kind: "suppliers" } | { kind: "request"; id: string };

function readView(): PurchasingView {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("pedido");
  if (id) return { kind: "request", id };
  const ver = params.get("ver");
  if (ver === "novo") return { kind: "new" };
  if (ver === "fornecedores") return { kind: "suppliers" };
  return { kind: "list" };
}

function writeView(view: PurchasingView) {
  const url = new URL(window.location.href);
  url.searchParams.delete("pedido");
  url.searchParams.delete("ver");
  if (view.kind === "request") url.searchParams.set("pedido", view.id);
  if (view.kind === "new") url.searchParams.set("ver", "novo");
  if (view.kind === "suppliers") url.searchParams.set("ver", "fornecedores");
  window.history.pushState({ module: "orcamentos" }, "", `${url.pathname}${url.search}${url.hash}`);
}

export function PurchasingPage() {
  const [view, setView] = useState<PurchasingView>(readView);
  useEffect(() => {
    const onPop = () => setView(readView());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((next: PurchasingView) => {
    writeView(next);
    setView(next);
    document.querySelector(".po-page")?.scrollTo({ top: 0 });
  }, []);
  const section = view.kind === "suppliers" ? "suppliers" : "requests";

  return (
    <ToastProvider>
      <section className="po-page" aria-label="Orçamentos">
        <div className="po-shell">
          {view.kind !== "new" ? (
            <nav className="po-section-nav" aria-label="Seções de Orçamentos">
              <button aria-current={section === "requests"} className={section === "requests" ? "is-on" : ""} onClick={() => go({ kind: "list" })} type="button">
                <ClipboardList size={15} aria-hidden="true" /> Pedidos
              </button>
              <button aria-current={section === "suppliers"} className={section === "suppliers" ? "is-on" : ""} onClick={() => go({ kind: "suppliers" })} type="button">
                <Store size={15} aria-hidden="true" /> Fornecedores
              </button>
            </nav>
          ) : null}
          <div className="po-view" key={view.kind === "request" ? view.id : view.kind}>
            {view.kind === "list" ? <RequestsList go={go} /> : null}
            {view.kind === "new" ? <NewRequestWizard go={go} /> : null}
            {view.kind === "request" ? <RequestDetail go={go} requestId={view.id} /> : null}
            {view.kind === "suppliers" ? <SuppliersPage /> : null}
          </div>
        </div>
      </section>
    </ToastProvider>
  );
}
