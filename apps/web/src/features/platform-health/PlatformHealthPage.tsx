import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, RefreshCw, Search, ShieldCheck, XCircle } from "lucide-react";
import { useTalkAuth } from "../../app/auth";
import { apiPlatformHealth, SupervisionApiError, type PlatformHealthChannel, type PlatformHealthConnection, type PlatformHealthLevel } from "../../app/supervision-api";
import "./platform-health.css";

const REFRESH_MS = 30_000;
const levelLabel: Record<PlatformHealthLevel, string> = { ok: "Saudável", warning: "Atenção", critical: "Crítico" };

/** "agora", "12 min", "3 h", "2 dias" since a moment, or "nunca". */
export function sinceLabel(at: string | null, now: number) {
  if (!at) return "nunca";
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 1440)} dias`;
}
export function formatPhone(phone: string | null) {
  const digits = phone?.replace(/\D/g, "") ?? "";
  const match = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone ?? "sem número";
}

function LevelIcon({ level }: { level: PlatformHealthLevel }) {
  return level === "ok" ? <CheckCircle2 size={16} aria-hidden="true" /> : level === "warning" ? <AlertTriangle size={16} aria-hidden="true" /> : <XCircle size={16} aria-hidden="true" />;
}

function ConnectionPill({ provider, connection, now }: { provider: "evolution" | "waha"; connection?: PlatformHealthConnection; now: number }) {
  const name = provider === "waha" ? "WAHA" : "Evolution";
  if (!connection) return <span className="health-pill is-missing" title={`${name} não configurada`}><i aria-hidden="true" />{name}<small>não conectada</small></span>;
  const tone = connection.status !== "connected" ? "is-down" : connection.lastError || !connection.eligible || connection.health === "degraded" || connection.health === "unhealthy" ? "is-warn" : "is-up";
  const detail = connection.status !== "connected" ? "desconectada" : connection.lastError === "PHONE_MISMATCH" ? "outro celular" : connection.lastError ?? (connection.eligible ? `evento há ${sinceLabel(connection.lastEventAt, now)}` : "não verificada");
  return <span className={`health-pill ${tone}`} title={[`${name}: ${connection.status} / ${connection.health}`, connection.verifiedPhone ? `celular ${formatPhone(connection.verifiedPhone)}` : null,
    `${connection.events1h} eventos na última hora`, connection.lastHealthyAt ? `última verificação boa há ${sinceLabel(connection.lastHealthyAt, now)}` : null].filter(Boolean).join("\n")}>
    <i aria-hidden="true" />{name}<small>{detail}</small></span>;
}

function ChannelCard({ channel, now }: { channel: PlatformHealthChannel; now: number }) {
  const settled = channel.acks.sent + channel.acks.delivered + channel.acks.read;
  const ticks = settled ? Math.round(((channel.acks.delivered + channel.acks.read) / settled) * 100) : null;
  return <article className={`health-card is-${channel.level}`}>
    <header>
      <span className={`health-level is-${channel.level}`}><LevelIcon level={channel.level} />{levelLabel[channel.level]}</span>
      <div><strong>{channel.name}</strong><small>{formatPhone(channel.phone)}</small></div>
    </header>
    <div className="health-pills">
      <ConnectionPill provider="evolution" connection={channel.connections.find(connection => connection.provider === "evolution")} now={now} />
      <ConnectionPill provider="waha" connection={channel.connections.find(connection => connection.provider === "waha")} now={now} />
    </div>
    <dl className="health-stats">
      <div><dt>Última recebida</dt><dd>{sinceLabel(channel.traffic.lastInboundAt, now)}</dd></div>
      <div><dt>Recebidas 1 h / 24 h</dt><dd>{channel.traffic.inbound1h} / {channel.traffic.inbound24h}</dd></div>
      <div><dt>Enviadas 24 h</dt><dd>{channel.traffic.outbound24h}</dd></div>
      <div><dt>Com ✓✓ (24 h)</dt><dd>{ticks === null ? "—" : `${ticks}%`}</dd></div>
    </dl>
    {channel.issues.length ? <ul className="health-issues">
      {channel.issues.map(issue => <li key={issue.text} className={`is-${issue.level}`}><LevelIcon level={issue.level} />{issue.text}</li>)}
    </ul> : <p className="health-fine">Tudo funcionando: duas conexões no mesmo celular, mensagens chegando e confirmações voltando.</p>}
  </article>;
}

/** Hub admins only: every customer's numbers, worst first, refreshed every 30 s. */
export function PlatformHealthPage() {
  const { getToken } = useTalkAuth();
  const [channels, setChannels] = useState<PlatformHealthChannel[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "problems">("all");
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const tokenRef = useRef(getToken); tokenRef.current = getToken;
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true);
    try {
      const data = await apiPlatformHealth(() => tokenRef.current(), controller.signal);
      setChannels(data.channels); setGeneratedAt(data.generatedAt); setError(null); setDenied(null);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof SupervisionApiError && (cause.status === 401 || cause.status === 403)) {
        setDenied(cause.status === 401 ? "Sua sessão expirou. Entre novamente pelo Hub." : "Esta tela é só para administradores do Hub.");
        setChannels(null);
      } else setError(cause instanceof Error ? cause.message : "Não foi possível consultar a saúde dos números.");
    } finally { if (request.current === controller) setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const refresh = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => { window.clearInterval(refresh); window.clearInterval(tick); request.current?.abort(); };
  }, [load]);

  const totals = useMemo(() => ({
    ok: channels?.filter(channel => channel.level === "ok").length ?? 0,
    warning: channels?.filter(channel => channel.level === "warning").length ?? 0,
    critical: channels?.filter(channel => channel.level === "critical").length ?? 0
  }), [channels]);
  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    const visible = (channels ?? []).filter(channel => (filter === "all" || channel.level !== "ok")
      && (!term || [channel.name, channel.workspaceName, channel.phone, channel.workspaceId].some(value => value?.toLowerCase().includes(term))));
    const byWorkspace = new Map<string, PlatformHealthChannel[]>();
    for (const channel of visible) byWorkspace.set(channel.workspaceId, [...(byWorkspace.get(channel.workspaceId) ?? []), channel]);
    return [...byWorkspace.values()];
  }, [channels, filter, search]);

  return <div className="health-page">
    <header className="health-header">
      <div className="health-brand"><span className="health-brand-mark"><Activity size={20} aria-hidden="true" /></span><strong>Saúde dos números</strong><span>Prymeira Talk · todos os clientes</span></div>
      <div className="health-refresh">
        <small>{generatedAt ? `Atualizado há ${sinceLabel(generatedAt, now)} · a cada 30 s` : ""}</small>
        <button type="button" onClick={() => { void load(); }} disabled={loading}><RefreshCw size={15} aria-hidden="true" className={loading ? "is-refreshing" : ""} />Atualizar</button>
      </div>
    </header>
    {denied ? <section className="health-denied" role="alert"><ShieldCheck size={32} aria-hidden="true" /><h2>Acesso restrito</h2><p>{denied}</p></section> : <main className="health-content">
      <section className="health-summary" aria-label="Resumo">
        <button type="button" className={filter === "all" ? "is-active" : undefined} onClick={() => setFilter("all")}><strong>{channels?.length ?? "—"}</strong>números</button>
        <span className="is-ok"><CheckCircle2 size={18} aria-hidden="true" /><strong>{totals.ok}</strong>saudáveis</span>
        <span className="is-warning"><AlertTriangle size={18} aria-hidden="true" /><strong>{totals.warning}</strong>atenção</span>
        <span className="is-critical"><XCircle size={18} aria-hidden="true" /><strong>{totals.critical}</strong>críticos</span>
        <button type="button" className={filter === "problems" ? "is-active" : undefined} onClick={() => setFilter(current => current === "problems" ? "all" : "problems")}>Só com problema</button>
        <label className="health-search"><Search size={15} aria-hidden="true" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Cliente, número ou canal" /></label>
      </section>
      {error ? <p className="health-error" role="alert">{error}</p> : null}
      {channels === null && loading ? <p className="health-empty">Consultando os números…</p> : null}
      {channels && !groups.length ? <p className="health-empty">{filter === "problems" ? "Nenhum número com problema agora." : "Nenhum número encontrado."}</p> : null}
      {groups.map(group => <section key={group[0]!.workspaceId} className="health-workspace">
        {/* Talk keeps no workspace name when the Hub never sent one: the numbers' names say whose it is. */}
        <h2>{group[0]!.workspaceName ?? group.map(channel => channel.name).join(" · ")}<small>{group.length} {group.length === 1 ? "número" : "números"} · {group[0]!.workspaceId.slice(0, 8)}</small></h2>
        <div className="health-grid">{group.map(channel => <ChannelCard key={channel.channelId} channel={channel} now={now} />)}</div>
      </section>)}
    </main>}
  </div>;
}
