import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LeadJobDto, LeadListDto, LeadResultDto, LeadSource, SimilarCompanySearchResult } from "@prymeira-talk/shared";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, RefreshCw, SearchX, Sparkles } from "lucide-react";
import { useTalkAuth } from "../../app/auth";
import {
  apiCreateLeadCampaignDraft, apiDeleteLeadList, apiDownloadLeadErrors, apiGetLeadJob, apiGetLeadLists, apiGetLeadResults,
  apiGetSimilarLeads, apiImportLeadContacts, apiLookupReceitaLeads, apiRetryLeadJob,
  apiSaveSimilarLeadList, apiStartGoogleLeadSearch, apiStartReceitaLeadSearch,
  apiUploadLeadCsv, apiVerifyLeadWhatsapp
} from "../../app/api";
import { LeadSearchPanel } from "./LeadSearchPanel";
import { LeadListSidebar } from "./LeadListSidebar";
import { LeadResultsTable } from "./LeadResultsTable";
import { LeadActionsBar } from "./LeadActionsBar";
import { formatCnpj, jobLabels, scoreReasons } from "./lead-display";

type Action = "verify" | "import" | "campaign";
type Lookup = Awaited<ReturnType<typeof apiLookupReceitaLeads>>;
type CsvResult = Awaited<ReturnType<typeof apiUploadLeadCsv>>;

function navigateModule(module: "contatos" | "disparos", campaignId?: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("module", module);
  if (campaignId) url.searchParams.set("campaign", campaignId);
  window.history.pushState({ module }, "", `${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Não foi possível ler o CSV."));
    reader.readAsDataURL(file);
  });
}

function newestLists(lists: LeadListDto[]) {
  return [...new Map(lists.map(list => [list.id, list])).values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

export function LeadsPage() {
  const { getToken } = useTalkAuth();
  const [source, setSource] = useState<LeadSource>("google_maps");
  const [lists, setLists] = useState<LeadListDto[]>([]);
  const [expandedLists, setExpandedLists] = useState(false);
  const [hasMoreLists, setHasMoreLists] = useState(false);
  const [loadingMoreLists, setLoadingMoreLists] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LeadListDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const loadedPagesRef = useRef(1);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [items, setItems] = useState<LeadResultDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<Record<string, LeadJobDto>>({});
  const [verificationJobs, setVerificationJobs] = useState<LeadJobDto[]>([]);
  const [csvResult, setCsvResult] = useState<CsvResult | null>(null);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [similar, setSimilar] = useState<SimilarCompanySearchResult | null>(null);
  const [similarSeed, setSimilarSeed] = useState<LeadResultDto | null>(null);
  const [similarSelected, setSimilarSelected] = useState<Set<string>>(new Set());
  const [similarName, setSimilarName] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [campaignMessage, setCampaignMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nextLink, setNextLink] = useState<"contatos" | "disparos" | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);

  const refreshLists = useCallback(async () => {
    const loaded: LeadListDto[] = [];
    let lastPage: LeadListDto[] = [];
    for (let page = 1; page <= loadedPagesRef.current; page += 1) {
      lastPage = await apiGetLeadLists(getToken, page, 50);
      loaded.push(...lastPage);
      if (lastPage.length < 50) {
        loadedPagesRef.current = page;
        break;
      }
    }
    const result = newestLists(loaded);
    setHasMoreLists(lastPage.length === 50);
    setLists(result);
    return result;
  }, [getToken]);

  async function loadMoreLists() {
    if (!hasMoreLists || loadingMoreLists) return;
    setLoadingMoreLists(true);
    setError(null);
    try {
      const page = loadedPagesRef.current + 1;
      const next = await apiGetLeadLists(getToken, page, 50);
      if (next.length > 0) {
        loadedPagesRef.current = page;
        setLists(current => newestLists([...current, ...next]));
      }
      setHasMoreLists(next.length === 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível carregar mais listas.");
    } finally {
      setLoadingMoreLists(false);
    }
  }

  useEffect(() => {
    let live = true;
    void refreshLists().then(result => { if (live && result.length && !selectedListId) setSelectedListId(result[0].id); }).catch(err => { if (live) setError(err instanceof Error ? err.message : "Não foi possível carregar listas."); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [refreshLists]);

  useEffect(() => {
    if (!selectedListId) { setItems([]); setTotal(0); return; }
    let live = true;
    setLoading(true);
    void apiGetLeadResults(getToken, selectedListId, page).then(result => {
      if (!live) return;
      setItems(result.items); setTotal(result.total);
    }).catch(err => { if (live) setError(err instanceof Error ? err.message : "Não foi possível carregar resultados."); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [getToken, selectedListId, page]);

  useEffect(() => {
    const active = [...Object.values(jobs), ...verificationJobs].filter(job => job.status === "queued" || job.status === "running");
    if (!active.length) return;
    const timer = window.setInterval(() => {
      void Promise.all(active.map(job => apiGetLeadJob(getToken, job.id))).then(next => {
        setJobs(current => ({ ...current, ...Object.fromEntries(next.filter(job => current[job.listId]?.id === job.id).map(job => [job.listId, job])) }));
        setVerificationJobs(current => current.map(job => next.find(updated => updated.id === job.id) ?? job));
        if (next.some(job => job.status !== "queued" && job.status !== "running")) {
          void refreshLists();
          if (selectedListId) void apiGetLeadResults(getToken, selectedListId, page).then(result => { setItems(result.items); setTotal(result.total); });
        }
      }).catch(err => setError(err instanceof Error ? err.message : "Não foi possível acompanhar a operação."));
    }, 4000);
    return () => window.clearInterval(timer);
  }, [jobs, verificationJobs, getToken, refreshLists, selectedListId, page]);

  const selectedList = lists.find(list => list.id === selectedListId) ?? null;
  const selectedIds = useMemo(() => Array.from(selected), [selected]);
  const job = selectedListId ? jobs[selectedListId] : undefined;

  function chooseList(id: string) { setSelectedListId(id); setPage(1); setSelected(new Set()); setSimilar(null); setError(null); }
  function toggle(id: string) { setSelected(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  function togglePage() { setSelected(current => { const next = new Set(current); const all = items.every(item => next.has(item.id)); items.forEach(item => all ? next.delete(item.id) : next.add(item.id)); return next; }); }
  function fail(err: unknown) { setError(err instanceof Error ? err.message : "Ocorreu um erro."); }
  async function perform(task: () => Promise<void>) { setBusy(true); setError(null); setNotice(null); setNextLink(null); try { await task(); } catch (err) { fail(err); } finally { setBusy(false); } }
  function acceptSearch(result: { list: LeadListDto; job: LeadJobDto }) {
    setLists(current => [result.list, ...current.filter(list => list.id !== result.list.id)]);
    setJobs(current => ({ ...current, [result.list.id]: result.job }));
    chooseList(result.list.id);
    setNotice("Busca iniciada. A lista será atualizada conforme os resultados chegarem.");
  }

  async function confirmDelete() {
    if (!deleteTarget || busy) return;
    const target = deleteTarget;
    setBusy(true);
    setDeleteError(null);
    try {
      await apiDeleteLeadList(getToken, target.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Não foi possível excluir a lista.");
      setBusy(false);
      return;
    }

    const remaining = lists.filter(list => list.id !== target.id);
    setLists(remaining);
    setJobs(current => { const next = { ...current }; delete next[target.id]; return next; });
    setVerificationJobs(current => current.filter(job => job.listId !== target.id));
    setDeleteTarget(null);
    setNotice(`Lista “${target.name}” excluída.`);
    setError(null);
    if (selectedListId === target.id) {
      setSelectedListId(remaining[0]?.id ?? null);
      setPage(1);
      setItems([]);
      setTotal(0);
      setSelected(new Set());
      setSimilar(null);
      setSimilarSeed(null);
    }
    try {
      await refreshLists();
    } catch {
      setError("A lista foi excluída, mas não foi possível atualizar as demais. Atualize a página.");
    } finally {
      setBusy(false);
    }
  }

  async function startSimilar(lead: LeadResultDto) {
    if (!selectedListId) return;
    await perform(async () => { const result = await apiGetSimilarLeads(getToken, selectedListId, lead.id); setSimilar(result); setSimilarSeed(lead); setSimilarSelected(new Set()); setSimilarName(`Similares a ${lead.tradeName || lead.companyName || formatCnpj(lead.cnpj)}`); });
  }

  async function confirmAction() {
    if (!selectedListId || !action) return;
    await perform(async () => {
      if (action === "verify") {
        const result = await apiVerifyLeadWhatsapp(getToken, selectedListId, selectedIds);
        setVerificationJobs(result.jobs);
        setNotice(`Verificação de ${result.requestedCount} lead${result.requestedCount === 1 ? "" : "s"} iniciada.`);
      } else if (action === "import") {
        const result = await apiImportLeadContacts(getToken, selectedListId, selectedIds);
        setNotice(`${result.importedCount} contatos cadastrados ou atualizados; ${result.skippedCount} ignorados.`);
        setNextLink("contatos");
      } else {
        const imported = await apiImportLeadContacts(getToken, selectedListId, selectedIds);
        const eligibleIds = imported.contacts.filter(contact => contact.contactId && contact.provenanceId).map(contact => contact.leadId);
        if (!eligibleIds.length) throw new Error("Nenhum lead selecionado tem telefone válido para criar o rascunho.");
        const result = await apiCreateLeadCampaignDraft(getToken, selectedListId, eligibleIds, campaignMessage.trim());
        setNotice(`Rascunho criado para ${result.contactCount} contato${result.contactCount === 1 ? "" : "s"}. Nenhum disparo foi enviado.`);
        setCampaignId(result.campaignId); setNextLink("disparos");
      }
      setAction(null);
    });
  }

  return <main className="leads-page" aria-label="Leads">
    <header className="leads-header"><div><span className="leads-eyebrow">PROSPECÇÃO</span><h1>Leads</h1><p>Encontre empresas, organize listas e prepare o próximo contato.</p></div><div className="leads-header-stat"><b>{lists.reduce((sum, list) => sum + list.totalCount, 0)}</b><span>resultados nas listas</span></div></header>
    <div className="leads-layout"><LeadListSidebar lists={lists} selectedId={selectedListId} onSelect={chooseList} source={source} expanded={expandedLists} hasMore={hasMoreLists} loadingMore={loadingMoreLists} busy={busy} onToggleExpanded={() => setExpandedLists(current => !current)} onLoadMore={() => void loadMoreLists()} onRequestDelete={list => { setDeleteTarget(list); setDeleteError(null); }} />
      <div className="leads-content"><div className="leads-tabs" role="tablist" aria-label="Fonte da busca"><button role="tab" aria-selected={source === "google_maps"} type="button" onClick={() => setSource("google_maps")}>Google Maps</button><button role="tab" aria-selected={source === "receita_federal"} type="button" onClick={() => setSource("receita_federal")}>Receita Federal</button></div>
        <LeadSearchPanel source={source} busy={busy} onGoogle={value => void perform(async () => acceptSearch(await apiStartGoogleLeadSearch(getToken, { ...value, idempotencyKey: crypto.randomUUID(), maxTimeSeconds: 600 })))} onReceita={(name, filters) => void perform(async () => acceptSearch(await apiStartReceitaLeadSearch(getToken, name, filters)))} onLookup={query => void perform(async () => { setLookup(await apiLookupReceitaLeads(getToken, query)); setNotice("Consulta concluída."); })} onCsv={(file, name) => void perform(async () => { if (file.size > 5 * 1024 * 1024) throw new Error("O CSV excede 5 MiB."); const result = await apiUploadLeadCsv(getToken, { name, fileName: file.name, csvBase64: await fileBase64(file) }); setCsvResult(result); await refreshLists(); chooseList(result.listId); setJobs(current => ({ ...current, [result.listId]: { id: result.jobId, listId: result.listId, status: "queued" } as LeadJobDto })); setNotice(`${result.acceptedRows} linhas aceitas; ${result.invalidRows} inválidas; ${result.duplicateRows} duplicadas.`); })} />
        {lookup && <section className="leads-lookup" aria-label="Resultado da consulta"><div className="leads-section-heading"><span>Consulta de empresa</span><button type="button" onClick={() => setLookup(null)}>Fechar</button></div>{lookup.items.length ? lookup.items.map(item => <p key={item.cnpj}><b>{item.tradeName || item.companyName || "Empresa"}</b> · {formatCnpj(item.cnpj)}</p>) : <p>Nenhuma empresa encontrada.</p>}</section>}
        {(error || notice) && <div className={`leads-feedback${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>{error || notice}{nextLink && <button type="button" onClick={() => navigateModule(nextLink, campaignId ?? undefined)}>{nextLink === "contatos" ? "Abrir Contatos" : "Abrir rascunho em Disparos"}</button>}</div>}
        {csvResult && csvResult.invalidRows > 0 && <button className="leads-download" type="button" onClick={() => void perform(async () => { const blob = await apiDownloadLeadErrors(getToken, csvResult.jobId); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "lead-errors.csv"; link.click(); URL.revokeObjectURL(url); })}><Download size={15} /> Baixar erros do CSV</button>}
        <section className="leads-results" aria-label="Resultados da lista"><div className="leads-results-head"><div><span className="leads-eyebrow">LISTA SELECIONADA</span><h2>{selectedList?.name || "Resultados"}</h2><p>{selectedList ? `${total} empresas · ${selectedList.source === "google_maps" ? "Google Maps" : "Receita Federal"}` : "Escolha uma lista ou inicie uma busca."}</p></div>{selectedListId && <button className="secondary-button" type="button" onClick={() => void perform(async () => { await refreshLists(); const result = await apiGetLeadResults(getToken, selectedListId, page); setItems(result.items); setTotal(result.total); })}><RefreshCw size={15} /> Atualizar</button>}</div>
          {job && <div className={`leads-job status-${job.status}`} role="status"><div><strong>{jobLabels[job.status]}</strong><span>{selectedList?.processedCount ?? 0} processados · {selectedList?.failedCount ?? 0} falhas</span>{job.errorMessage && <small>{job.errorMessage}</small>}</div>{(job.status === "failed" || job.status === "partial") && job.retryable !== false && <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(async () => { const next = await apiRetryLeadJob(getToken, job.id); setJobs(current => ({ ...current, [next.listId]: next })); setNotice("Nova tentativa iniciada."); })}>Tentar novamente</button>}</div>}
          {verificationJobs.filter(item => item.listId === selectedListId).map((item, index) => <div className={`leads-job status-${item.status}`} role="status" key={item.id}><div><strong>WhatsApp · lote {index + 1}: {jobLabels[item.status]}</strong>{item.errorMessage && <small>{item.errorMessage}</small>}</div>{(item.status === "failed" || item.status === "partial") && item.retryable !== false && <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(async () => { const next = await apiRetryLeadJob(getToken, item.id); setVerificationJobs(current => current.map(currentJob => currentJob.id === item.id ? next : currentJob)); setNotice("Nova tentativa de verificação iniciada."); })}>Tentar novamente</button>}</div>)}
          {loading ? <p className="leads-empty">Carregando resultados…</p> : items.length ? <><LeadResultsTable items={items} selected={selected} onToggle={toggle} onSelectAll={togglePage} onSimilar={lead => void startSimilar(lead)} /><div className="leads-pagination"><span>Página {page} · {total} resultados</span><button type="button" disabled={page === 1} onClick={() => setPage(page - 1)} aria-label="Página anterior"><ChevronLeft size={16} /></button><button type="button" disabled={page * 25 >= total} onClick={() => setPage(page + 1)} aria-label="Próxima página"><ChevronRight size={16} /></button></div></> : <div className="leads-empty"><SearchX size={28} /><h3>Um bom recorte começa pela fonte certa</h3><p>Use Google Maps para negócios locais e Receita Federal para filtrar empresas por atividade, cidade ou CNPJ.</p></div>}
          {selectedListId && <LeadActionsBar count={selected.size} busy={busy} onVerify={() => setAction("verify")} onImport={() => setAction("import")} onCampaign={() => setAction("campaign")} />}
        </section>
        {similar && <section className="leads-similar" aria-label="Empresas semelhantes"><div className="leads-section-heading"><span><Sparkles size={16} /> Similares a {similar.seed.tradeName || similar.seed.companyName || formatCnpj(similar.seed.cnpj)}</span><button type="button" onClick={() => setSimilar(null)}><ArrowLeft size={15} /> Voltar</button></div><p className="leads-muted">Pontuação considera atividade, localização, perfil e dados comerciais. Empresas sem correspondência suficiente ficam fora do resultado.</p>{similar.items.length ? <>{similar.items.map(item => <label className="leads-similar-item" key={item.cnpj}><input type="checkbox" checked={similarSelected.has(item.cnpj)} onChange={() => setSimilarSelected(current => { const next = new Set(current); next.has(item.cnpj) ? next.delete(item.cnpj) : next.add(item.cnpj); return next; })} /><span><b>{item.tradeName || item.companyName || formatCnpj(item.cnpj)}</b><small>{formatCnpj(item.cnpj)} · {[item.city, item.state].filter(Boolean).join(" / ")}</small><small>{scoreReasons(item).join(" · ") || "Sem motivos detalhados"}</small></span><strong className="leads-score">{Math.round(item.score)}</strong></label>)}<div className="leads-similar-save"><input className="text-input" aria-label="Nome da lista de similares" maxLength={160} value={similarName} onChange={e => setSimilarName(e.target.value)} /><button className="primary-button" type="button" disabled={busy || !similarSelected.size || !similarName.trim() || !similarSeed || !selectedListId} onClick={() => void perform(async () => { if (!similarSeed || !selectedListId) return; acceptSearch(await apiSaveSimilarLeadList(getToken, { listId: selectedListId, leadId: similarSeed.id, name: similarName.trim(), selectedCnpjs: [...similarSelected] })); setSimilar(null); })}>Salvar {similarSelected.size} em lista</button></div></> : <p>Nenhuma empresa elegível encontrada.</p>}</section>}
      </div></div>
    {action && <div className="leads-dialog-backdrop" role="presentation"><section className="leads-dialog" role="dialog" aria-modal="true" aria-labelledby="leads-confirm-title"><span className="leads-eyebrow">CONFIRMAÇÃO</span><h2 id="leads-confirm-title">{action === "verify" ? "Verificar WhatsApp" : action === "import" ? "Cadastrar contatos" : "Criar lote de disparo"}</h2><p>{selected.size} lead{selected.size === 1 ? "" : "s"} selecionado{selected.size === 1 ? "" : "s"}. {action === "verify" ? "A verificação será executada em segundo plano." : action === "import" ? "Os contatos válidos serão cadastrados ou associados aos existentes." : "Os contatos com telefone válido serão cadastrados ou associados. Será criado apenas um rascunho; nenhum envio começa agora."}</p>{action === "campaign" && <label>Mensagem comum<textarea className="text-input" rows={4} value={campaignMessage} onChange={e => setCampaignMessage(e.target.value)} placeholder="Escreva a mensagem que será revisada no rascunho" /></label>}<div className="leads-dialog-actions"><button type="button" className="secondary-button" onClick={() => setAction(null)}>Cancelar</button><button type="button" className="primary-button" disabled={busy || (action === "campaign" && !campaignMessage.trim())} onClick={() => void confirmAction()}>Confirmar {selected.size}</button></div></section></div>}
    {deleteTarget && <div className="leads-dialog-backdrop" role="presentation"><section className="leads-dialog" role="dialog" aria-modal="true" aria-labelledby="leads-delete-title">
      <span className="leads-eyebrow">EXCLUIR LISTA</span>
      <h2 id="leads-delete-title">Excluir “{deleteTarget.name}”?</h2>
      <p>Esta ação apaga permanentemente a lista, seus resultados, verificações de WhatsApp e jobs vinculados. Contatos já importados não serão apagados; listas com esses vínculos não podem ser excluídas.</p>
      {deleteError && <p className="leads-delete-error" role="alert">{deleteError}</p>}
      <div className="leads-dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setDeleteTarget(null)}>Cancelar</button><button type="button" className="leads-danger-button" disabled={busy} onClick={() => void confirmDelete()}>{busy ? "Excluindo…" : "Excluir definitivamente"}</button></div>
    </section></div>}
  </main>;
}
