import { useTalkAuth } from "../../app/auth";
import { Download, FileText, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  apiGetReportsOverview,
  type ReportFiltersDto,
  type ReportMetricDto,
  type ReportPeriodPresetDto,
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

const periodPresets: Array<{ key: ReportPeriodPresetDto; label: string }> = [
  { key: "today", label: "Hoje" },
  { key: "7d", label: "7 dias" },
  { key: "30d", label: "30 dias" },
  { key: "month", label: "Mes atual" },
  { key: "custom", label: "Personalizado" }
];

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

function reportRows(overview: ReportsOverviewDto) {
  return [
    { section: "Indicadores", rows: overview.cards },
    { section: "Conversas por status", rows: overview.conversationsByStatus },
    { section: "Mensagens por direção", rows: overview.messagesByDirection },
    { section: "Resultados de disparos", rows: overview.campaignResults },
    { section: "Runs de automação", rows: overview.automationRuns },
    { section: "Departamentos", rows: overview.breakdowns.departments },
    { section: "Tags", rows: overview.breakdowns.tags },
    { section: "Canais", rows: overview.breakdowns.channels }
  ];
}

function exportOverviewCsv(overview: ReportsOverviewDto) {
  const header = ["section", "label", "value", "helper"].map(escapeCsvCell).join(",");
  const body = reportRows(overview)
    .flatMap((section) =>
      section.rows.map((row) =>
        [section.section, row.label, row.value, row.helper ?? ""].map(escapeCsvCell).join(",")
      )
    )
    .join("\n");
  const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "relatorios-prymeira-talk.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function periodLabel(filters: ReportFiltersDto) {
  const preset = periodPresets.find((item) => item.key === filters.preset)?.label ?? "Período";

  if (filters.startDate || filters.endDate) {
    return `${preset}: ${filters.startDate ?? "..."} até ${filters.endDate ?? "..."}`;
  }

  return preset;
}

async function exportOverviewPdf(overview: ReportsOverviewDto) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 44;
  let cursorY = 56;

  const ensureSpace = (height: number) => {
    if (cursorY + height <= pageHeight - margin) return;
    doc.addPage();
    cursorY = 56;
  };
  const writeSection = (title: string, rows: ReportMetricDto[]) => {
    ensureSpace(44 + rows.length * 18);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(title, margin, cursorY);
    cursorY += 20;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);

    if (rows.length === 0) {
      doc.text("Sem dados", margin, cursorY);
      cursorY += 20;
      return;
    }

    for (const row of rows) {
      ensureSpace(22);
      doc.text(row.label, margin, cursorY);
      doc.text(formatNumber(row.value), pageWidth - margin, cursorY, { align: "right" });
      cursorY += 18;
    }
    cursorY += 10;
  };

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("Relatorio Prymeira Talk", margin, cursorY);
  cursorY += 26;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`Gerado em ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date())}`, margin, cursorY);
  cursorY += 16;
  doc.text(periodLabel(overview.filters), margin, cursorY);
  cursorY += 28;

  for (const section of reportRows(overview)) {
    writeSection(section.section, section.rows);
  }

  doc.save("relatorios-prymeira-talk.pdf");
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
          <span>Dimensão</span>
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
  const { getToken } = useTalkAuth();
  const [overview, setOverview] = useState<ReportsOverviewDto | null>(null);
  const [filters, setFilters] = useState<Partial<ReportFiltersDto>>({ preset: "30d" });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadOverview() {
    setIsLoading(true);
    setError(null);

    try {
      const nextOverview = await apiGetReportsOverview(getToken, filters);
      setOverview(nextOverview);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar relatórios.");
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
        const nextOverview = await apiGetReportsOverview(getToken, filters);

        if (isMounted) {
          setOverview(nextOverview);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar relatórios.");
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
  }, [filters, getToken]);

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
  const currentFilters = overview?.filters ?? {
    preset: filters.preset ?? "30d",
    startDate: filters.startDate ?? null,
    endDate: filters.endDate ?? null,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.channelId ? { channelId: filters.channelId } : {}),
    ...(filters.departmentId ? { departmentId: filters.departmentId } : {})
  };
  const channelOptions = overview?.breakdowns.channels ?? [];
  const departmentOptions = overview?.breakdowns.departments ?? [];

  return (
    <section className="module-page reports-page" aria-label="Relatórios">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Relatórios</h1>
        </div>
        <div className="module-header-actions">
          <span className={`status-badge status-badge--${isLoading ? "waiting" : "open"}`}>
            {isLoading ? "Carregando" : "Atualizado"}
          </span>
          <button className="secondary-button" type="button" onClick={() => void loadOverview()}>
            <RefreshCw size={14} />
            Atualizar
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!overview}
            onClick={() => overview ? exportOverviewCsv(overview) : undefined}
          >
            <Download size={14} />
            Exportar CSV
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!overview}
            onClick={() => overview ? void exportOverviewPdf(overview) : undefined}
          >
            <FileText size={14} />
            Exportar PDF
          </button>
        </div>
      </header>

      {error ? <p className="error-note">{error}</p> : null}

      <section className="module-panel reports-control-panel" aria-label="Filtros de relatórios">
        <div className="reports-period-buttons">
          {periodPresets.map((preset) => (
            <button
              className={currentFilters.preset === preset.key ? "is-active" : ""}
              key={preset.key}
              onClick={() => setFilters((current) => ({
                ...current,
                preset: preset.key,
                ...(preset.key === "custom" ? {} : { startDate: undefined, endDate: undefined })
              }))}
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="reports-filter-grid">
          <label className="form-field">
            <span>Inicio</span>
            <input
              onChange={(event) => setFilters((current) => ({
                ...current,
                preset: "custom",
                startDate: event.target.value || undefined
              }))}
              type="date"
              value={currentFilters.startDate ?? ""}
            />
          </label>
          <label className="form-field">
            <span>Fim</span>
            <input
              onChange={(event) => setFilters((current) => ({
                ...current,
                preset: "custom",
                endDate: event.target.value || undefined
              }))}
              type="date"
              value={currentFilters.endDate ?? ""}
            />
          </label>
          <label className="form-field">
            <span>Status</span>
            <select
              onChange={(event) => setFilters((current) => ({
                ...current,
                status: event.target.value as ReportFiltersDto["status"] || undefined
              }))}
              value={currentFilters.status ?? ""}
            >
              <option value="">Todos</option>
              <option value="open">Abertas</option>
              <option value="pending">Pendentes</option>
              <option value="closed">Fechadas</option>
            </select>
          </label>
          <label className="form-field">
            <span>Canal</span>
            <select
              onChange={(event) => setFilters((current) => ({
                ...current,
                channelId: event.target.value || undefined
              }))}
              value={currentFilters.channelId ?? ""}
            >
              <option value="">Todos</option>
              {channelOptions.map((channel) => (
                <option key={channel.key} value={channel.key}>{channel.label}</option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Departamento</span>
            <select
              onChange={(event) => setFilters((current) => ({
                ...current,
                departmentId: event.target.value || undefined
              }))}
              value={currentFilters.departmentId ?? ""}
            >
              <option value="">Todos</option>
              {departmentOptions
                .filter((department) => department.key !== "unassigned")
                .map((department) => (
                  <option key={department.key} value={department.key}>{department.label}</option>
                ))}
            </select>
          </label>
        </div>
        <p className="reports-applied-period">{periodLabel(currentFilters)}</p>
      </section>

      <div className="contacts-stats-row" aria-label="Indicadores">
        {(cards.length > 0 ? cards : loadingCards).map((card) => (
          <div key={card.key} className="contacts-stat">
            <strong>{formatNumber(card.value)}</strong>
            <span>{card.label}</span>
          </div>
        ))}
      </div>

      <div className="reports-grid">
        <BarSection
          title="Conversas por status"
          subtitle="Local data"
          rows={overview?.conversationsByStatus ?? []}
        />
        <BarSection
          title="Mensagens por direção"
          subtitle="Inbound vs outbound"
          rows={overview?.messagesByDirection ?? []}
        />
        <BarSection
          title="Resultados de disparos"
          subtitle="Campanhas"
          rows={overview?.campaignResults ?? []}
        />
        <BarSection
          title="Runs de automação"
          subtitle="Execuções"
          rows={overview?.automationRuns ?? []}
        />
      </div>

      <div className="module-panel reports-timeline-panel">
        <div className="panel-title-row">
          <h2>Série temporal</h2>
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
