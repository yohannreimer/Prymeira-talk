import Fastify, { type FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { deriveTrustedMessagingContext } from '../messaging/canonical-source.js';
import { record } from '../messaging/whatsapp-identity.js';
import { secretMatches, signatureMatches, singleHeader, authenticateWaha } from './authentication.js';
import { normalizeReceipt } from './normalization.js';
import { IngressJournal } from './journal.js';
import type { ConfirmedIngressPublisher } from './broker.js';
import type { WahaLidResolver } from '../waha/waha-lid-resolver.js';
import { failureCode, reportFailure } from '../../observability/glitchtip.js';

type Provider = 'evolution' | 'waha' | 'meta_official';
class HttpFailure extends Error { constructor(readonly status: number, message: string) { super(message); } get code() { return this.message; } }
export interface IngressHttpOptions {
  stage?: 'isolated-1a' | 'isolated-1b' | string;
  db: PrismaClient; journal: IngressJournal; publisher: () => ConfirmedIngressPublisher | null;
  evolutionSecret: string; wahaSecret: string; workspaceAllowlist: ReadonlySet<string>;
  maxInflight?: number;
  /** Explicit server-owned private URL aliases, never supplied by a webhook. */
  evolutionAliases?: string[];
  /** WAHA's own LID→phone lookup: the only proof that a WAHA LID chat is a known phone number. */
  wahaLids?: Pick<WahaLidResolver, 'resolve'> | null;
}
/** Dedicated isolated server: never imports createApp or starts business schedulers. */
export function createIngressHttp(options: IngressHttpOptions) {
  if (!options.workspaceAllowlist.size) throw new Error('Stage 1A requires an explicit isolated workspace allowlist');
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024, requestTimeout: 10000 });
  let inflight = 0;
  const admitted = new WeakSet<object>();
  app.addHook('onRequest', async (request, reply) => {
    if (inflight >= (options.maxInflight ?? 32)) return reply.code(503).send({ error: 'ingress_backpressure' });
    admitted.add(request); inflight++;
  });
  const release = async (request: FastifyRequest) => { if (admitted.delete(request)) inflight--; };
  app.addHook('onResponse', release);
  app.addHook('onRequestAbort', release);
  app.addHook('onTimeout', release);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as { statusCode?: number };
    if (failure.statusCode === 413) return reply.code(413).send({ error: 'payload_too_large' });
    if (failure.statusCode === 415) return reply.code(415).send({ error: 'json_required' });
    reportFailure('ingress_http', error);
    return reply.code(503).send({ error: 'ingress_unavailable' });
  });
  async function credential(tx: Prisma.TransactionClient, provider: Provider, workspaceId: string, request: FastifyRequest, raw: Buffer) {
    if (provider === 'evolution') {
      if (!secretMatches(singleHeader(request, 'x-prymeira-talk-secret'), options.evolutionSecret)) throw new HttpFailure(401, 'invalid_webhook_secret');
      return;
    }
    if (provider === 'waha') {
      if (!authenticateWaha(request, raw, options.wahaSecret)) throw new HttpFailure(401, 'invalid_waha_signature');
      return;
    }
    const config = await tx.integrationConfig.findUnique({ where: { workspaceId_provider: { workspaceId, provider: 'meta_cloud' } } });
    const settings = record(config?.settings);
    if (config?.mode !== 'real' || settings.enabled !== true || settings.connectionMode === 'evolution_official') throw new HttpFailure(409, 'inactive_meta_source');
    const header = singleHeader(request, 'x-hub-signature-256');
    if (typeof settings.appSecret !== 'string' || !header?.startsWith('sha256=') || !signatureMatches(header.slice(7), raw, settings.appSecret.trim(), 'sha256')) throw new HttpFailure(401, 'invalid_meta_signature');
  }
  async function sourceFor(tx: Prisma.TransactionClient, provider: Provider, workspaceId: string, input: unknown, observedAt: string, connectionId?: string) {
    const envelope = record(input);
    if (provider === 'meta_official') {
      const config = await tx.integrationConfig.findUnique({ where: { workspaceId_provider: { workspaceId, provider: 'meta_cloud' } } });
      const phoneNumberId = record(config?.settings).phoneNumberId;
      if (typeof phoneNumberId !== 'string') throw new HttpFailure(409, 'inactive_meta_source');
      const channel = await tx.channel.findUnique({ where: { workspaceId_provider_providerKey: { workspaceId, provider: 'meta_cloud', providerKey: phoneNumberId.trim() } } });
      if (!channel) throw new HttpFailure(409, 'unknown_source');
      return deriveTrustedMessagingContext(tx, { workspaceId, channelId: channel.id, authenticatedSource: { provider, connectionId: null, phoneNumberId: phoneNumberId.trim() }, mode: 'live', observedAt });
    }
    const data = record(envelope.data);
    const mode = provider === 'evolution' && (data.type === 'append' || data.type === 'history' || data.isHistory === true) ? 'history' as const : 'live' as const;
    const session = provider === 'evolution' ? envelope.instance : envelope.session;
    if (typeof session !== 'string' || !session || session.length > 200 || typeof envelope.event !== 'string' || !envelope.event || envelope.event.length > 100) throw new HttpFailure(400, 'invalid_source_envelope');
    const connection = await tx.channelConnection.findUnique({ where: { workspaceId_provider_sessionName: { workspaceId, provider, sessionName: session } } });
    if (connection && (!connectionId || connection.id === connectionId)) {
      return deriveTrustedMessagingContext(tx, { workspaceId, channelId: connection.channelId, authenticatedSource: { provider, connectionId: connection.id }, mode, observedAt });
    }
    if (provider === 'evolution' && !connectionId && !connection) {
      const config = await tx.integrationConfig.findUnique({ where: { workspaceId_provider: { workspaceId, provider: 'meta_cloud' } } });
      const settings = record(config?.settings);
      if (settings.connectionMode === 'evolution_official' && settings.evolutionInstanceName === session) {
        const channels = await tx.channel.findMany({ where: { workspaceId, provider: 'meta_cloud' }, take: 2 });
        if (channels.length === 1) return deriveTrustedMessagingContext(tx, { workspaceId, channelId: channels[0]!.id,
          authenticatedSource: { provider: 'evolution', connectionId: null, sessionName: session }, mode, observedAt });
      }
    }
    throw new HttpFailure(409, 'unknown_source');
  }
  function register(provider: Provider, path: string) {
    app.post(path, async (request, reply) => {
      let phase = 'authentication';
      try {
        const params = request.params as { workspaceId: string; connectionId?: string }, workspaceId = params.workspaceId;
        if (!options.workspaceAllowlist.has(workspaceId)) throw new HttpFailure(403, 'workspace_not_allowlisted');
        if (!Buffer.isBuffer(request.body)) throw new HttpFailure(400, 'raw_json_required');
        const raw = request.body;
        // Authentication always precedes JSON parsing or private filesystem writes.
        await options.db.$transaction(tx => credential(tx, provider, workspaceId, request, raw));
        let input: unknown;
        try { input = JSON.parse(raw.toString('utf8')); } catch { throw new HttpFailure(400, 'invalid_json'); }
        const publisher = options.publisher();
        if (!publisher?.ready) throw new HttpFailure(503, 'publisher_backpressure');
        const observedAt = new Date().toISOString();
        phase = 'source';
        // A plain read: the source is re-checked under the shared source fence when the receipt is staged.
        const source = await options.db.$transaction(tx => sourceFor(tx, provider, workspaceId, input, observedAt, params.connectionId), { isolationLevel: 'ReadCommitted' });
        // Bounded and cached; a failed lookup is no proof (the event is still accepted, as before).
        const enrichment = provider === 'waha' && options.wahaLids ? { verifiedLidMappings: await options.wahaLids.resolve(source.sessionName, input).catch(() => []) } : undefined;
        let payload;
        phase = 'normalization';
        try { payload = normalizeReceipt(source, input, enrichment); } catch { throw new HttpFailure(400, 'source_payload_mismatch'); }
        phase = 'stage';
        const receipt = await options.journal.stage({ transportNamespace: publisher.namespace, source, raw, payload,
          authentication: provider === 'evolution' ? 'evolution_constant_time_secret' : provider === 'waha' ? 'waha_raw_hmac_sha512' : 'meta_raw_hmac_sha256',
          reauthenticate: async tx => {
            await credential(tx, provider, workspaceId, request, raw);
            const current = await sourceFor(tx, provider, workspaceId, input, observedAt, params.connectionId);
            if (JSON.stringify(current) !== JSON.stringify(source)) throw new HttpFailure(409, 'source_changed');
          } });
        phase = 'publish';
        await options.journal.publish(receipt.id, publisher);
        return reply.code(202).send({ ok: true, receiptId: receipt.id, state: 'pending_application' });
      } catch (error) {
        if (!(error instanceof HttpFailure) || error.status >= 500) {
          if (reportFailure('ingress_http', error)) console.warn('Ingress request failed', { phase, code: failureCode(error) });
        }
        return reply.code(error instanceof HttpFailure ? error.status : 503).send({ error: error instanceof HttpFailure ? error.message : 'ingress_unavailable' });
      }
    });
  }
  register('evolution', '/webhooks/evolution/:workspaceId');
  for (const alias of options.evolutionAliases ?? []) {
    if (!/^\/[a-zA-Z0-9/_-]+\/:workspaceId$/.test(alias) || alias === '/webhooks/evolution/:workspaceId') throw new Error('Invalid Evolution private alias');
    register('evolution', alias);
  }
  register('waha', '/webhooks/waha/:workspaceId');
  register('waha', '/webhooks/waha/:workspaceId/:connectionId');
  register('meta_official', '/webhooks/meta/:workspaceId');
  app.get('/webhooks/meta/:workspaceId', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string }, query = request.query as Record<string, string>;
    if (!options.workspaceAllowlist.has(workspaceId)) return reply.code(403).send({ error: 'workspace_not_allowlisted' });
    const config = await options.db.integrationConfig.findUnique({ where: { workspaceId_provider: { workspaceId, provider: 'meta_cloud' } } });
    const settings = record(config?.settings);
    if (config?.mode !== 'real' || settings.enabled !== true || settings.connectionMode === 'evolution_official' || typeof settings.webhookVerifyToken !== 'string'
      || query['hub.mode'] !== 'subscribe' || !query['hub.challenge'] || !secretMatches(query['hub.verify_token'] ?? null, settings.webhookVerifyToken)) return reply.code(403).send({ error: 'invalid_verification' });
    return reply.type('text/plain').send(query['hub.challenge']);
  });
  app.get('/health', async (_request, reply) => reply.code(options.publisher()?.ready ? 200 : 503).send({ stage: options.stage ?? 'isolated-1a', application: options.stage === 'isolated-1b' || options.stage === 'production' ? 'separate_canonical_worker_required' : 'not_connected' }));
  return app;
}
