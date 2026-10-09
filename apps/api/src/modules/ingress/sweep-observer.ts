import { failureCode, reportFailure, type FailurePoint } from '../../observability/glitchtip.js';
/** Cheap local timing, no tracing or payload capture. Counts are allowlisted, summaries are emitted at most every
 * five minutes. Independent failures are reported through the existing private, rate-limited error integration. */
export function createSweepObserver(logger = console, now = Date.now) {
  const steps = new Map<string, { runs: number; failures: number; totalMs: number; maxMs: number; counts: Record<string, number> }>();
  let lastLog = 0;
  return {
    async run<T>(step: 'recertification' | 'authority' | 'history' | 'lids' | 'gaps', point: FailurePoint, task: () => Promise<T>) {
      const at = now();
      let result: T | undefined, failed = false;
      try { result = await task(); return result; }
      catch (error) {
        failed = true; reportFailure(point, error);
        logger.warn('Ingress background step failed', { step, code: failureCode(error) });
        return undefined;
      } finally {
        // Add only completed work: a summary emitted during a long history import must not drop its duration.
        const summary = steps.get(step) ?? { runs: 0, failures: 0, totalMs: 0, maxMs: 0, counts: {} };
        steps.set(step, summary); summary.runs++; if (failed) summary.failures++;
        const duration = now() - at; summary.totalMs += duration; summary.maxMs = Math.max(summary.maxMs, duration);
        if (result && typeof result === 'object') for (const key of ['examined', 'applied', 'imported', 'resolved', 'merged', 'recovered']) {
          const value = (result as Record<string, unknown>)[key];
          if (typeof value === 'number' && Number.isFinite(value)) summary.counts[key] = (summary.counts[key] ?? 0) + value;
        }
      }
    },
    flush() {
      if (now() - lastLog < 5 * 60_000) return;
      lastLog = now();
      logger.info('Ingress background summary', Object.fromEntries([...steps].map(([step, value]) => [step, { ...value, counts: { ...value.counts } }])));
      steps.clear();
    }
  };
}
