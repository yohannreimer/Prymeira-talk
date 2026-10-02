import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelHealthAlertList } from "./ChannelHealthAlerts";
import { describeWatchdogProblem } from "./channel-problems";

describe("ChannelHealthAlertList", () => {
  it("não renderiza nada sem problemas", () => {
    expect(renderToStaticMarkup(<ChannelHealthAlertList problems={[]} onOpenChannels={vi.fn()} />)).toBe("");
  });
  it("mostra título, detalhe e o botão para abrir Canais", () => {
    const html = renderToStaticMarkup(<ChannelHealthAlertList onOpenChannels={vi.fn()} problems={[
      { channelId: "a", tone: "danger", title: "Vendas 6 está desconectado", detail: "Abra Canais e reconecte." }
    ]} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Vendas 6 está desconectado");
    expect(html).toContain("Abra Canais e reconecte.");
    expect(html).toContain("Abrir Canais");
    expect(html).toContain("channel-alert-danger");
  });
  it("lista vários avisos, cada um com seu tom", () => {
    const html = renderToStaticMarkup(<ChannelHealthAlertList onOpenChannels={vi.fn()} problems={[
      { channelId: "a", tone: "danger", title: "A", detail: "x" },
      { channelId: "b", tone: "warning", title: "B", detail: "y" }
    ]} />);
    expect(html).toContain("channel-alert-warning");
    expect((html.match(/channel-alert /g) ?? []).length).toBe(2);
  });
  it("renderiza o tom info", () => {
    const html = renderToStaticMarkup(<ChannelHealthAlertList onOpenChannels={vi.fn()} problems={[
      { channelId: "a", tone: "info", title: "Reconectando", detail: "z" }
    ]} />);
    expect(html).toContain("channel-alert-info");
  });
  it("mostra o aviso do monitoramento vindo do helper", () => {
    const problem = describeWatchdogProblem({ enabled: true, lastTickAt: null, lastTickOk: true, lastError: null, unreachable: true })!;
    const html = renderToStaticMarkup(<ChannelHealthAlertList onOpenChannels={vi.fn()} problems={[problem]} />);
    expect(html).toContain("O monitoramento dos canais não consegue falar com a Evolution");
    expect(html).toContain("channel-alert-warning");
  });
});
