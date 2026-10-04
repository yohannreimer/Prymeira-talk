import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InboxQuickFilters } from "./InboxQuickFilters";

describe("InboxQuickFilters", () => {
  it("renders three accessible buttons with one selected view; the short name shows only when the list is wide", () => {
    const html = renderToStaticMarkup(<InboxQuickFilters value="reply" onChange={() => undefined} />);
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Não lidas no Talk"');
    expect(html).toContain('aria-label="Marcadas pela equipe"');
    expect(html).toContain('aria-label="Responder"');
    expect(html).toContain('aria-pressed="true"');
    // The visible short name is decoration for sighted users; screen readers get the full aria-label once.
    expect(html).toContain('<span class="inbox-quick-filter-label" aria-hidden="true">Não lidas</span>');
    expect(html).toContain('<span class="inbox-quick-filter-label" aria-hidden="true">Marcadas</span>');
  });
});
