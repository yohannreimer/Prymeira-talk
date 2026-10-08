import type { Event, ErrorEvent } from '@sentry/node';

export type FailurePoint = 'api' | 'ingress_http' | 'transport_setup' | 'transport_delivery'
  | 'application_retry' | 'application_dead_letter' | 'recertification_event'
  | 'recertification_sweep' | 'effect_loop' | 'effect_handler' | 'effect_exhausted'
  | 'waha_history' | 'gap_recovery' | 'lid_resolution' | 'fatal';
const points = new Set<FailurePoint>(['api', 'ingress_http', 'transport_setup', 'transport_delivery',
  'application_retry', 'application_dead_letter', 'recertification_event', 'recertification_sweep',
  'effect_loop', 'effect_handler', 'effect_exhausted', 'waha_history', 'gap_recovery', 'lid_resolution', 'fatal']);
const namedCodes = new Set(['HISTORY_DUPLICATE_MESSAGE', 'MEDIA_UNAVAILABLE', 'MEDIA_TIMEOUT', 'MEDIA_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE', 'PROSPECTING_STATE_UNKNOWN', 'EFFECT_WITHOUT_MESSAGE', 'NOT_AN_ATTACHMENT', 'STALE_SOURCE']);
const brokerCodes = new Set(['publisher_backpressure', 'publisher_unavailable', 'publication_in_progress', 'publish_deadline',
  'publish_nack', 'publish_error', 'unroutable', 'broker_blocked', 'channel_error', 'channel_closed', 'connection_error', 'connection_closed', 'publisher_closed']);
const safeCode = /^(?:P\d{4}|HISTORY_HTTP_\d{3}|EVOLUTION_HTTP_\d{3}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|HANDLER_THREW)$/;
const isSafeCode = (code: string) => safeCode.test(code) || namedCodes.has(code)
  || (code.startsWith('INGRESS_') && brokerCodes.has(code.slice(8).toLowerCase()));

/** Never forward a query, provider payload, URL, phone, token or raw exception message. */
export function failureCode(error: unknown): string {
  const record = typeof error === 'object' && error !== null ? error as { code?: unknown; errorCode?: unknown; message?: unknown } : {};
  for (const code of [record.code, record.errorCode]) {
    if (typeof code !== 'string') continue;
    if (isSafeCode(code)) return code;
    if (brokerCodes.has(code)) return `INGRESS_${code.toUpperCase()}`;
    if (code === 'stale_source') return 'STALE_SOURCE';
  }
  const message = typeof record.message === 'string' ? record.message : typeof error === 'string' ? error : '';
  if (namedCodes.has(message)) return message;
  const provider = message.match(/^Evolution API request failed with status (\d{3})$/);
  if (provider) return `EVOLUTION_HTTP_${provider[1]}`;
  if (message.includes('unexpected end of hex escape')) return 'INVALID_UNICODE';
  const history = message.match(/\bHISTORY_HTTP_\d{3}\b/);
  if (history) return history[0];
  return 'UNEXPECTED_ERROR';
}

/** Also protects fatal SDK events, which otherwise may carry raw requests and exception text. */
export function privateEvent(event: Event): ErrorEvent | null {
  if (event.type) return null;
  const candidate = event.tags?.failure_point;
  const point = typeof candidate === 'string' && points.has(candidate as FailurePoint) ? candidate : 'fatal';
  const original = event.exception?.values?.[0];
  const supplied = event.tags?.failure_code;
  const code = typeof supplied === 'string' && (isSafeCode(supplied) || ['INVALID_UNICODE', 'UNEXPECTED_ERROR'].includes(supplied))
    ? supplied : failureCode({ message: original?.value });
  // A new allowlisted event, rather than deleting a few fields from a potentially private event.
  return { type: undefined, event_id: event.event_id, timestamp: event.timestamp, platform: 'node',
    environment: 'production', release: /^[a-f0-9]{7,40}$/.test(event.release ?? '') ? event.release : undefined,
    level: 'error', exception: { values: [{ type: 'OperationalFailure', value: `${point}: ${code}` }] },
    tags: { failure_point: point, failure_code: code,
      service: ['api', 'ingress', 'ingress_worker'].includes(String(event.tags?.service)) ? String(event.tags?.service) : 'unknown' },
    fingerprint: ['talk', point, code] };
}

/** Bounded rate gate. Monitoring failure must never fail the original operation. */
export function createFailureReporter(send: (point: FailurePoint, code: string) => void, now = Date.now) {
  const last = new Map<string, number>();
  let windowStart = now(), sent = 0;
  return (point: FailurePoint, error: unknown): boolean => {
    try {
      const at = now(), code = failureCode(error), key = `${point}:${code}`;
      if (at - windowStart >= 60_000) { windowStart = at; sent = 0; }
      if (sent >= 10 || at - (last.get(key) ?? -Infinity) < 60_000) return false;
      last.set(key, at); sent++;
      // Keep memory bounded even if callers produce many distinct error codes.
      if (last.size > 200) for (const [entry, time] of last) if (at - time >= 60_000) last.delete(entry);
      send(point, code);
      return true;
    } catch { return false; }
  };
}

let report: ReturnType<typeof createFailureReporter> | undefined;
let sdk: typeof import('@sentry/node') | undefined;
export function reportFailure(point: FailurePoint, error: unknown) { return report?.(point, error) ?? false; }

export async function initializeGlitchTip(service: 'api' | 'ingress' | 'ingress_worker', env = process.env): Promise<boolean> {
  if (!env.GLITCHTIP_DSN) return false;
  try {
    const dsn = new URL(env.GLITCHTIP_DSN);
    if (dsn.protocol !== 'https:' || dsn.hostname !== 'glitchtip.prymeiradigital.com.br' || !dsn.username || !/^\/\d+$/.test(dsn.pathname)) throw new Error('Invalid DSN');
    // Disabled deployments do not load the SDK or install instrumentation.
    const Sentry = await import('@sentry/node');
    Sentry.initWithoutDefaultIntegrations({ dsn: env.GLITCHTIP_DSN, release: env.GLITCHTIP_RELEASE,
      environment: 'production', defaultIntegrations: false,
      integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration()],
      enableOpenTelemetrySetup: false, enableRuntimeChannelInjection: false, includeServerName: false,
      tracesSampleRate: 0, beforeSendTransaction: () => null, beforeSendLog: () => null,
      beforeSendMetric: () => null, maxBreadcrumbs: 0, debug: false, spotlight: false,
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [],
        urlQueryParams: false, graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
        databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0 },
      sendClientReports: false, beforeSend: privateEvent,
      transportOptions: { bufferSize: 10 }, shutdownTimeout: 2000,
      initialScope: { tags: { service } } });
    sdk = Sentry;
    report = createFailureReporter((point, code) => {
      // The same bounded, private diagnostic in the local logs makes incidents
      // traceable even when an HTTP boundary intentionally hides the raw error.
      console.warn('Talk operational failure', { service, point, code });
      Sentry.captureException(new Error(`${point}: ${code}`), { tags: { service, failure_point: point, failure_code: code } });
    });
    console.info('GlitchTip error reporting enabled', { service });
    return true;
  } catch {
    console.warn('GlitchTip configuration rejected; error reporting disabled');
    return false;
  }
}

export async function flushGlitchTip() { if (report && sdk) await sdk.flush(2000).catch(() => false); }
