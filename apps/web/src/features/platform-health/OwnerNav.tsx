/** The product owner's pages, every customer at once (Hub admins only). */
export function OwnerNav({ current }: { current: "saude" | "avaliacao" }) {
  return <nav className="owner-nav" aria-label="Páginas do administrador">
    <a href="?module=saude" aria-current={current === "saude" ? "page" : undefined}>Saúde dos números</a>
    <a href="?module=avaliacao" aria-current={current === "avaliacao" ? "page" : undefined}>Avaliação dos agentes</a>
  </nav>;
}
