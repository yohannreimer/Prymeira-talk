import { Prisma } from '@prisma/client';
type Scope = { workspaceId: string; channelId: string };
export type CanonicalAddressGraphRow = { id: string; redirectId: string | null };

/** Every redirect and its destination stay visible, including unrelated cycles.
 * Only isolated nodes outside the requested set are omitted: they cannot belong
 * to a requested family. IDs are still read under their full tenant/channel
 * scope, never assumed valid because a caller supplied them. Rare callers that
 * do not know their seeds retain the complete graph path. */
export async function readCanonicalAddressGraphRows(tx: Prisma.TransactionClient, scope: Scope, seeds?: readonly string[]) {
  if (seeds === undefined) return tx.canonicalAddress.findMany({ where: scope, select: { id: true, redirectId: true } });
  if (!seeds.length) throw Error('Canonical graph requires an address seed');
  return tx.$queryRaw<CanonicalAddressGraphRow[]>`WITH canonical_graph_redirects AS MATERIALIZED (
    SELECT id, redirect_id FROM canonical_addresses
    WHERE workspace_id=${scope.workspaceId} AND channel_id=${scope.channelId}::uuid AND redirect_id IS NOT NULL
  )
  SELECT id, redirect_id AS "redirectId" FROM canonical_graph_redirects
  UNION
  SELECT id, redirect_id AS "redirectId" FROM canonical_addresses
  WHERE workspace_id=${scope.workspaceId} AND channel_id=${scope.channelId}::uuid
    AND (id IN (${Prisma.join(seeds.map(id => Prisma.sql`${id}::uuid`))})
      OR id IN (SELECT redirect_id FROM canonical_graph_redirects))`;
}
export function canonicalAddressGraph(rows: CanonicalAddressGraphRow[]) {
  const parents = new Map(rows.map(r => [r.id, r.redirectId]));
  function root(id: string) {
    const seen = new Set<string>();
    while (parents.get(id)) {
      if (seen.has(id)) throw Error('Canonical address redirect cycle');
      seen.add(id); id = parents.get(id)!;
    }
    if (!parents.has(id)) throw Error('Invalid canonical address scope');
    return id;
  }
  return { root, has: (id: string) => parents.has(id), family: (id: string) => rows.filter(r => root(r.id) === root(id)).map(r => r.id) };
}
