/** Fixed provider records with real pagination metadata. The opaque physical ID
 * is independent of the requested message key and remains stable across scans. */
export function evolutionExactPage(records: readonly unknown[], query: { page?: number; offset?: number } = {}) {
  const currentPage = query.page ?? 1, offset = query.offset ?? 100;
  return { messages: { pages: Math.ceil(records.length / offset), currentPage, total: records.length,
    records: records.slice((currentPage - 1) * offset, currentPage * offset).map((item, index) =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? { id: `fixture-physical-${(currentPage - 1) * offset + index}`, ...item } : item) } };
}
