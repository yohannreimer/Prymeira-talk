import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InboxQuickFilters } from "./InboxQuickFilters";

describe("InboxQuickFilters", () => {
  it("renders only three accessible icon buttons with one selected view", () => {
    const html = renderToStaticMarkup(<InboxQuickFilters value="reply" onChange={() => undefined} />);
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Não lidas no Talk"');
    expect(html).toContain('aria-label="Marcadas pela equipe"');
    expect(html).toContain('aria-label="Responder"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('>Responder<');
  });
});
