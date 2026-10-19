import type { Event, ErrorEvent, EventHint } from '@sentry/node';
import { describeFailure, diagnosticFromEvent, diagnosticTags, failureCode, failurePoint, safeCode,
  type FailurePoint, type OperationalDiagnostic, type DiagnosticContext } from './operational-diagnostic.js';
export { failureCode } from './operational-diagnostic.js';
export type { FailurePoint } from './operational-diagnostic.js';

/** Also protects fatal SDK events, which otherwise may carry raw requests and exception text. */
export function privateEvent(event: Event, hint?: EventHint): ErrorEvent | null {
  if (event.type) return null;
  const point = failurePoint(event.tags?.failure_point);
  const original = event.exception?.values?.[0];
  const supplied = event.tags?.failure_code;
  const rawDiagnostic = event.tags?.diagnostic_version !== '1' && hint?.originalException
    ? describeFailure(point, hint.originalException) : undefined;
  const code = safeCode(supplied) ? supplied : rawDiagnostic?.code ?? failureCode({ message: original?.value });
  const diagnostic = diagnosticFromEvent(point, code, rawDiagnostic ? diagnosticTags(rawDiagnostic) : event.tags ?? {}, original);
  const location = diagnostic.frames[0];
  // Rebuild every field; raw exception text, SDK context and frame data never leave here.
  return { type: undefined, event_id: /^[a-f0-9]{32}$/.test(event.event_id ?? '') ? event.event_id : undefined, timestamp: typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : undefined, platform: 'node',
    environment: 'production', release: /^[a-f0-9]{7,40}$/.test(event.release ?? '') ? event.release : undefined,
    level: 'error', exception: { values: [{ type: diagnostic.type, value: `${point}: ${code}. ${diagnostic.technical_summary}`,
      ...(diagnostic.frames.length ? { stacktrace: { frames: [...diagnostic.frames].reverse() } } : {}) }] },
    tags: { failure_point: point, failure_code: code, ...diagnosticTags(diagnostic),
      service: ['api', 'ingress', 'ingress_worker'].includes(String(event.tags?.service)) ? String(event.tags?.service) : 'unknown' },
    fingerprint: ['talk', point, code, ...(['Error', 'UnknownError'].includes(diagnostic.type) ? [] : [diagnostic.type]),
      ...diagnostic.causes.map(c => `${c.type}:${c.code}`), ...(location ? [`${location.filename}:${location.lineno ?? 0}`] : [])] };

}

/** Bounded rate gate. Monitoring failure must never fail the original operation. */
export function createFailureReporter(send: (point: FailurePoint, code: string, diagnostic: OperationalDiagnostic) => void, now = Date.now) {
  const last = new Map<string, number>();
  let windowStart = now(), sent = 0;
  return (point: FailurePoint, error: unknown, context: DiagnosticContext & { diagnostic?: OperationalDiagnostic } = {}): boolean => {
    try {
      const at = now(), code = failureCode(error);
      const proposed = context.diagnostic ?? describeFailure(point, error, context);
      const diagnostic = diagnosticFromEvent(point, code, diagnosticTags(proposed), undefined);
      const first = diagnostic.frames[0];
      const key = JSON.stringify([point, code, diagnostic.type, diagnostic.causes.map(c => `${c.type}:${c.code}`),
        first?.filename, first?.lineno, diagnostic.impact]);
      if (at - windowStart >= 60_000) { windowStart = at; sent = 0; }
      if (sent >= 10 || at - (last.get(key) ?? -Infinity) < 60_000) return false;
      last.set(key, at); sent++;
      // Keep memory bounded even if callers produce many distinct error codes.
      if (last.size > 200) for (const [entry, time] of last) if (at - time >= 60_000) last.delete(entry);
      send(point, code, diagnostic);
      return true;
    } catch { return false; }
  };
}

let report: ReturnType<typeof createFailureReporter> | undefined;
let sdk: typeof import('@sentry/node') | undefined;
export function reportFailure(point: FailurePoint, error: unknown, context: DiagnosticContext & { diagnostic?: OperationalDiagnostic } = {}) { return report?.(point, error, context) ?? false; }

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
    report = createFailureReporter((point, code, diagnostic) => {
      // The same bounded, private diagnostic in the local logs makes incidents
      // traceable even when an HTTP boundary intentionally hides the raw error.
      console.warn('Talk operational failure', { service, point, ...diagnostic });
      Sentry.captureException(new Error(`${point}: ${code}`), { tags: { service, failure_point: point, failure_code: code, ...diagnosticTags(diagnostic) } });
    });
    console.info('GlitchTip error reporting enabled', { service });
    return true;
  } catch {
    console.warn('GlitchTip configuration rejected; error reporting disabled');
    return false;
  }
}

export async function flushGlitchTip() { if (report && sdk) await sdk.flush(2000).catch(() => false); }
