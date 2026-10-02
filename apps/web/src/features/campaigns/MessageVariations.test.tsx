import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageVariations } from "./MessageVariations";

const base = { message: "Olá {{nome}}, temos aço.", variations: [] as string[], busy: false,
  error: null as string | null, onGenerate: vi.fn(), onChange: vi.fn(), onRemove: vi.fn() };

describe("MessageVariations", () => {
  it("oferece gerar variações quando não há nenhuma", () => {
    const html = renderToStaticMarkup(<MessageVariations {...base} />);
    expect(html).toContain("Gerar 5 variações");
    expect(html).toContain("Variações (0 de 5)");
  });
  it("mostra cada variação editável e o aviso de campo ausente", () => {
    const html = renderToStaticMarkup(<MessageVariations {...base}
      variations={["Oi {{nome}}, tenho aço.", "Oi, tenho aço."]} />);
    expect(html).toContain("Variações (2 de 5)");
    expect(html).toContain("Oi, tenho aço.");
    expect(html).toContain("Falta o campo {{nome}}");
    expect(html).toContain("Regerar variações");
  });
  it("desabilita o botão sem mensagem ou enquanto gera", () => {
    expect(renderToStaticMarkup(<MessageVariations {...base} message=" " />)).toContain("disabled");
    expect(renderToStaticMarkup(<MessageVariations {...base} busy />)).toContain("Gerando");
  });
  it("anuncia avisos de campo ausente sem alertas e rotula cada botão de remover", () => {
    const html = renderToStaticMarkup(<MessageVariations {...base}
      variations={["Oi {{nome}}, tenho aço.", "Oi, tenho aço."]} />);
    expect(html).toContain('aria-label="Remover variação 1"');
    expect(html).toContain('aria-label="Remover variação 2"');
    expect(html).not.toContain('role="alert"');
    expect(html).toMatch(/role="status" aria-live="polite"[^>]*>Falta o campo/);
  });
  it("avisa quando as variações são de outra versão da mensagem", () => {
    const stale = renderToStaticMarkup(<MessageVariations {...base} variations={["Oi {{nome}}."]} stale />);
    expect(stale).toContain("A mensagem original mudou depois que estas variações foram geradas. Revise cada uma ou gere de novo.");
    expect(renderToStaticMarkup(<MessageVariations {...base} variations={["Oi {{nome}}."]} stale={false} />))
      .not.toContain("A mensagem original mudou");
  });
  it("mostra o erro da IA", () => {
    expect(renderToStaticMarkup(<MessageVariations {...base} error="A IA não está configurada para este workspace." />))
      .toContain("A IA não está configurada");
  });
});
