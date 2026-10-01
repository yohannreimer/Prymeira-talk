import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import fp from "fastify-plugin";

type Span = [number, number];
type InboxTiming = {
  start: number;
  hubMs: number;
  assemblyMs: number;
  database: Span[];
  serializationStart?: number;
  serializationMs: number;
};
const timingContext = new AsyncLocalStorage<InboxTiming>();

declare module "fastify" {
  interface FastifyRequest { inboxTiming?: InboxTiming }
}

export async function measureInboxHub<T>(operation: () => Promise<T>): Promise<T> {
  const timing = timingContext.getStore();
  if (!timing) return operation();
  const start = performance.now();
  try { return await operation(); }
  finally { timing.hubMs += performance.now() - start; }
}

export async function measureInboxDatabase<T>(operation: () => Promise<T>): Promise<T> {
  const timing = timingContext.getStore();
  if (!timing) return operation();
  const start = performance.now();
  try { return await operation(); }
  finally { timing.database.push([start, performance.now()]); }
}

export function measureInboxAssembly<T>(operation: () => T): T {
  const timing = timingContext.getStore();
  if (!timing) return operation();
  const start = performance.now();
  try { return operation(); }
  finally { timing.assemblyMs += performance.now() - start; }
}

// Prisma operations include pool/transport/decoding time and may execute several
// physical SQL statements. Merge overlapping waits for request-level DB wall time.
export function databaseWallTime(spans: Span[]): number {
  let total = 0;
  let end = -Infinity;
  for (const [start, stop] of [...spans].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}

export const inboxTimingPlugin = fp(async (app) => {
  app.decorateRequest("inboxTiming");
  app.addHook("onRequest", (request, reply, done) => {
    const pathname = request.url.split("?")[0];
    if (request.method !== "GET" || !/^\/conversations(?:\/(?:attention-count|[^/]+\/(?:messages|context)))?$/.test(pathname)) {
      done(); return;
    }
    const timing: InboxTiming = {start: performance.now(), hubMs: 0, assemblyMs: 0, database: [], serializationMs: 0};
    reply.header("Cache-Control", "private, no-store");
    request.inboxTiming = timing;
    timingContext.run(timing, done);
  });
  app.addHook("preSerialization", async (request) => {
    if (request.inboxTiming) request.inboxTiming.serializationStart = performance.now();
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const timing = request.inboxTiming;
    if (!timing) return payload;
    timing.serializationMs = timing.serializationStart ? performance.now() - timing.serializationStart : 0;
    const metrics = {
      hub: timing.hubMs, db_wait: databaseWallTime(timing.database), assembly: timing.assemblyMs,
      serialize: timing.serializationMs, total: performance.now() - timing.start,
    };
    reply.header("Server-Timing", Object.entries(metrics).map(([name, duration]) => `${name};dur=${duration.toFixed(2)}`).join(", "));
    // Only a static route and durations; no identifiers, messages, SQL or tokens.
    request.log.info({event: "inbox_read_timing", route: request.routeOptions.url, statusCode: reply.statusCode,
      ...metrics, databaseOperations: timing.database.length}, "Inbox read timing");
    return payload;
  });
});
