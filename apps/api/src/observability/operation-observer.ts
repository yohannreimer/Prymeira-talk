import { AsyncLocalStorage } from 'node:async_hooks';
import { reportFailure } from './glitchtip.js';
import { describeFailure, newCorrelation, field, safeCode, type FailurePoint, type OperationalDiagnostic } from './operational-diagnostic.js';

const scope = new AsyncLocalStorage<{ correlation_id: string; point: FailurePoint; error?: OperationalDiagnostic }>();
const observedResults = new WeakMap<object, string>();
const observedErrors = new WeakMap<object, string>();

/** Preserve the sanitized cause before a domain catch converts it to a result string. */
export function rememberOperationalError(error: unknown) {
  const current = scope.getStore();
  if (current) current.error = describeFailure(current.point, error, current);
}

export function reportOperationalException(point: FailurePoint, error: unknown) {
  if (typeof error === 'object' && error !== null && observedErrors.has(error) && (!scope.getStore() || observedErrors.get(error) === scope.getStore()?.correlation_id)) {
    if (!scope.getStore()) observedErrors.delete(error as object);
    return;
  }
  // Monitoring must not change the original result, even with a throwing injected transport.
  const correlation_id = scope.getStore()?.correlation_id ?? newCorrelation();
  try {
    const diagnostic = describeFailure(point, error, { correlation_id, impact: 'operation_failed' });
    const remembered = scope.getStore()?.error;
    // Persisting a failed run can itself fail. Retain the original technical
    // cause alongside the persistence error without retaining either raw message.
    if (remembered && (remembered.code !== diagnostic.code || remembered.type !== diagnostic.type)) {
      diagnostic.causes = [{ type: remembered.type, code: remembered.code,
        technical_cause: remembered.technical_cause, technical_summary: remembered.technical_summary },
      ...diagnostic.causes, ...remembered.causes].slice(0, 3);
      diagnostic.frames = [...diagnostic.frames, ...remembered.frames].slice(0, 4);
    }
    reportFailure(point, { code: diagnostic.code }, { diagnostic });
  } catch { /* isolated */ }
  if (typeof error === 'object' && error !== null) observedErrors.set(error, correlation_id);
}

/** Does not add telemetry/identifiers to the product result or alter exceptions/retries. */
export async function observeOperationalOperation<T extends { status: string }>(point: FailurePoint, work: () => Promise<T>): Promise<T> {
  const current = { point, correlation_id: scope.getStore()?.correlation_id ?? newCorrelation(), error: undefined as OperationalDiagnostic | undefined };
  return scope.run(current, async () => {
    try {
      const result = await work();
      if (result.status === 'failed' && observedResults.get(result) !== current.correlation_id) {
        const resultCode = field(result, 'errorCode');
        const diagnostic = current.error ?? describeFailure(point, { code: safeCode(resultCode) ? resultCode : 'AGENT_RUN_FAILED' }, current);
        diagnostic.impact = diagnostic.code === 'OUTBOUND_UNCERTAIN' ? 'delivery_unconfirmed' : 'operation_failed';
        try { reportFailure(point, { code: diagnostic.code }, { diagnostic }); } catch { /* isolated */ }
        observedResults.set(result, current.correlation_id);
      }
      return result;
    } catch (error) {
      reportOperationalException(point, error);
      throw error;
    }
  });
}
