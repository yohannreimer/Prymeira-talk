import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentTestInspection } from "./AgentTestInspection";

describe("test inspection", () => {
  it("shows literal extracted data and the unexecuted note without treating it as HTML", () => {
    const html = renderToStaticMarkup(<AgentTestInspection debug={{
      media: { status: "processed", fileName: "pedido.pdf", pages: 2, extractedText: "8 chapas <script>" },
      output: { handoff: { required: true, reason: "Pedido organizado" }, actions: [{ type: "create_internal_note", body: "8 chapas; entrega Joinville" }] }
    }} />);
    expect(html).toContain("8 chapas &lt;script&gt;");
    expect(html).toContain("não executado");
    expect(html).toContain("8 chapas; entrega Joinville");
  });
  it("makes absent seller summary explicit and fails closed on unreadable media", () => {
    const html = renderToStaticMarkup(<AgentTestInspection debug={{ media: { status: "failed" }, output: { handoff: { required: true }, actions: [] } }} />);
    expect(html).toContain("não gerou uma nota");
    expect(html).toContain("sem adivinhar");
  });
});
