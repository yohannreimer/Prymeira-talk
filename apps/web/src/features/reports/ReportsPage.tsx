import { useAuth } from "@clerk/clerk-react";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  apiGetReportsOverview,
  type ReportMetricDto,
  type ReportsOverviewDto
} from "../../app/api";

function formatNumber(value: number) {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function formatDate(value: string) {
  if (!value) return "-";

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short"
  }).format(new Date(`${value}T00:00:00`));
}

function maxMetricValue(metrics: ReportMetricDto[]) {
  return Math.max(1, ...metrics.map((metric) => metric.value));
}

function metricWidth(value: number, maxValue: number) {
  return `${Math.max(6, Math.round((value / maxValue) * 100))}%`;
}

function escapeCsvCell(value: string | number) {
  const text = String(value);

  if (!/[",\n\r]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll("\"", "\"\"")}"`;
}

const loadingCards: ReportMetricDto[] = ["conversations", "messages", "campaigns", "automations"].map((key) => ({
  key,
  label: "Carregando",
  value: 0
}));

function exportRows(title: string, rows: ReportMetricDto[]) {
  const header = ["label", "value"].map(escapeCsvCell).join(",");
  const body = rows.map((row) => [row.label, row.value].map(escapeCsvCell).join(",")).join("\n");
  const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `${title}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function BarSection(input: { title: string; subtitle: string; rows: ReportMetricDto[] }) {
  const maxValue = maxMetricValue(input.rows);

  return (
    <div className="module-panel">
      <div className="panel-title-row">
        <h2>{input.title}</h2>
        <span>{input.subtitle}</span>
      </div>
      <div className="report-bar-list">
        {input.rows.length === 0 ? <p className="list-note">Sem dados</p> : null}
        {input.rows.map((row) => (
          <div key={row.key} className="report-bar-row">
            <span>{row.label}</span>
            <strong>{formatNumber(row.value)}</strong>
            <em>
              <i style={{ width: metricWidth(row.value, maxValue) }} />
            </em>
          </div>
        ))}
      </div>
    </div>
  );
}

function BreakdownTable(input: { title: string; rows: ReportMetricDto[] }) {
  return (
    <div className="module-panel">
      <div className="panel-title-row">
        <h2>{input.title}</h2>
        <button
          className="icon-button"
          type="button"
          title={`Exportar ${input.title}`}
          onClick={() => exportRows(input.title.toLowerCase().replaceAll(" ", "-"), input.rows)}
        >
          <Download size={16} />
        </button>
      </div>
      <div className="report-table" role="table">
        <div className="report-table-row is-header" role="row">
          <span>Dimensao</span>
          <span>Total</span>
          <span>Share</span>
        </div>
        {input.rows.length === 0 ? (
          <div className="report-table-row" role="row">
            <span>Sem dados</span>
            <span>0</span>
            <span>0%</span>
          </div>
        ) : null}
        {input.rows.map((row) => {
          const total = input.rows.reduce((sum, current) => sum + current.value, 0) || 1;
          const share = Math.round((row.value / total) * 100);

          return (
            <div key={row.key} className="report-table-row" role="row">
              <span>{row.label}</span>
              <span>{formatNumber(row.value)}</span>
              <span>{share}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ReportsPage() {
  const { getToken } = useAuth();
  const [overview, setOverview] = useState<ReportsOverviewDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadOverview() {
    setIsLoading(true);
    setError(null);

    try {
      const nextOverview = await apiGetReportsOverview(getToken);
      setOverview(nextOverview);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar relatorios.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    let isMounted = true;

    async function loadInitialOverview() {
      setIsLoading(true);
      setError(null);

      try {
        const nextOverview = await apiGetReportsOverview(getToken);

        if (isMounted) {
          setOverview(nextOverview);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar relatorios.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadInitialOverview();

    return () => {
      isMounted = false;
    };
  }, [getToken]);

  const timelineMax = useMemo(() => {
    if (!overview) return 1;

    return Math.max(
      1,
      ...overview.timeSeries.map(
        (point) => point.conversations + point.inboundMessages + point.outboundMessages
      )
    );
  }, [overview]);

  const cards = overview?.cards ?? [];

  return (
    <section className="module-page" aria-label="Relatorios">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Relatorios</h1>
        </div>
        <span className="status-pill status-open">{isLoading ? "Carregando" : "Dados locais"}</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button" onClick={() => void loadOverview()}>
          <RefreshCw size={16} />
          Atualizar
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={!overview}
          onClick={() => exportRows("reports-cards", cards)}
        >
          <Download size={16} />
          Exportar CSV
        </button>
      </div>

      {error ? <p className="error-note">{error}</p> : null}

      <div className="metric-grid report-metric-grid" aria-label="Indicadores">
        {(cards.length > 0 ? cards : loadingCards).map((card) => (
          <article key={card.key} className="metric-card report-metric-card">
            <span>{card.label}</span>
            <strong>{formatNumber(card.value)}</strong>
            <p>{card.helper ?? "Total consolidado"}</p>
          </article>
        ))}
      </div>

      <div className="reports-grid">
        <BarSection
          title="Conversas por status"
          subtitle="Local data"
          rows={overview?.conversationsByStatus ?? []}
        />
        <BarSection
          title="Mensagens por direcao"
          subtitle="Inbound vs outbound"
          rows={overview?.messagesByDirection ?? []}
        />
        <BarSection
          title="Resultados de disparos"
          subtitle="Campanhas"
          rows={overview?.campaignResults ?? []}
        />
        <BarSection
          title="Runs de automacao"
          subtitle="Execucoes"
          rows={overview?.automationRuns ?? []}
        />
      </div>

      <div className="module-panel">
        <div className="panel-title-row">
          <h2>Serie temporal</h2>
          <span>{overview?.timeSeries.length ?? 0} pontos</span>
        </div>
        <div className="report-timeline">
          {(overview?.timeSeries ?? []).length === 0 ? <p className="list-note">Sem dados</p> : null}
          {(overview?.timeSeries ?? []).map((point) => {
            const total = point.conversations + point.inboundMessages + point.outboundMessages;

            return (
              <div key={point.date} className="report-timeline-row">
                <span>{formatDate(point.date)}</span>
                <em>
                  <i style={{ width: metricWidth(total, timelineMax) }} />
                </em>
                <strong>{formatNumber(total)}</strong>
              </div>
            );
          })}
        </div>
      </div>

      <div className="reports-grid">
        <BreakdownTable title="Departamentos" rows={overview?.breakdowns.departments ?? []} />
        <BreakdownTable title="Tags" rows={overview?.breakdowns.tags ?? []} />
        <BreakdownTable title="Canais" rows={overview?.breakdowns.channels ?? []} />
      </div>
    </section>
  );
}
