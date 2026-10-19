import { randomBytes } from 'node:crypto';
import contract from './diagnostic-contract.json' with { type: 'json' };

export { contract as diagnosticContract };
export type FailurePoint = keyof typeof contract.operations;
export type SafeFrame = { filename: string; lineno?: number; colno?: number };
export type SafeCause = { type: string; code: string; technical_cause: string; technical_summary: string };
export type OperationalDiagnostic = SafeCause & {
  version: 1; component: string; operation: string; location: string;
  frames: SafeFrame[]; causes: SafeCause[]; correlation_id: string;
  impact: string; recovery: 'unknown';
};
export type DiagnosticContext = { correlation_id?: string; impact?: 'unknown' | 'operation_failed' };
const namedCodes = new Set(contract.namedCodes);
const brokerCodes = new Set(contract.brokerCodes);
export const safeCode = (code: unknown): code is string => typeof code === 'string' && (
  /^(?:P\d{4}|HISTORY_HTTP_[1-5]\d{2}|EVOLUTION_HTTP_[1-5]\d{2}|WAHA_HTTP_[1-5]\d{2}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|HANDLER_THREW)$/.test(code)
  || namedCodes.has(code) || (code.startsWith('INGRESS_') && brokerCodes.has(code.slice(8).toLowerCase())));
export function field(value: unknown, key: string): unknown {
  try { return value !== null && (typeof value === 'object' || typeof value === 'function') ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}
export function failureCode(error: unknown): string {
  for (const code of [field(error, 'code'), field(error, 'errorCode')]) {
    if (safeCode(code)) return code;
    if (typeof code === 'string' && brokerCodes.has(code)) return `INGRESS_${code.toUpperCase()}`;
    if (code === 'stale_source') return 'STALE_SOURCE';
  }
  const name = field(error, 'name'), status = field(error, 'statusCode');
  if (name === 'WahaClientError' && Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599) return `WAHA_HTTP_${status}`;
  if (name === 'OutboundUncertainError') return 'OUTBOUND_UNCERTAIN';
  const message = field(error, 'message');
  const text = typeof message === 'string' ? message : typeof error === 'string' ? error : '';
  if (namedCodes.has(text)) return text;
  if (/ownKeys/.test(text) && /\$on/.test(text)) return 'PRISMA_PROXY_OWN_KEYS';
  const provider = text.match(/^Evolution API request failed with status ([1-5]\d{2})$/);
  if (provider) return `EVOLUTION_HTTP_${provider[1]}`;
  if (text.includes('unexpected end of hex escape')) return 'INVALID_UNICODE';
  return text.match(/\bHISTORY_HTTP_[1-5]\d{2}\b/)?.[0] ?? 'UNEXPECTED_ERROR';
}
export function technicalCause(code: string): string {
  if (code === 'PRISMA_PROXY_OWN_KEYS') return 'prisma_proxy_invariant';
  if (/^(WAHA|EVOLUTION|HISTORY)_HTTP_/.test(code)) return 'provider_http_failure';
  if (/^P\d{4}$/.test(code)) return 'database_error';
  if (/^(ECONN|ETIMEDOUT|ENOTFOUND|EPIPE|INGRESS_)/.test(code)) return 'network_error';
  if (code === 'INVALID_UNICODE') return 'invalid_unicode';
  if (code === 'AGENT_RUN_FAILED') return 'operation_returned_failed';
  if (code === 'OUTBOUND_UNCERTAIN') return 'delivery_unconfirmed';
  if (code === 'WAHA_DESTINATION_UNRESOLVED') return 'destination_resolution_failed';
  if (code.startsWith('TOOL_')) return 'tool_error';
  if (code.startsWith('MEDIA_')) return 'media_error';
  if (code === 'EMPTY_TRANSCRIPT' || code === 'TRANSCRIPTION_IN_PROGRESS') return 'transcription_error';
  return 'unexpected_error';
}
export const technicalSummary = (code: string): string => contract.causeDescriptions[technicalCause(code) as keyof typeof contract.causeDescriptions];
export const newCorrelation = () => `op_${randomBytes(16).toString('hex')}`;
const correlation = (value: unknown) => typeof value === 'string' && /^op_[a-f0-9]{32}$/.test(value) ? value : newCorrelation();
export const failurePoint = (value: unknown): FailurePoint => typeof value === 'string' && Object.hasOwn(contract.operations, value) ? value as FailurePoint : 'fatal';
const typeOf = (value: unknown) => typeof value === 'string' && contract.types.includes(value) ? value : 'UnknownError';
const sourceFiles = new Set(contract.sourceFiles);
const positive = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1_000_000 ? value : undefined;

/** Only release-owned source filenames or the bundler's fixed chunk/entry grammar. No functions, source, vars or URLs. */
export function safeFrame(value: unknown): SafeFrame | undefined {
  const filename = field(value, 'filename');
  if (typeof filename !== 'string' || filename.length > 4096 || /[?#\n\r\0\\]/.test(filename) || filename.includes('..') || /^(?!file:)[a-z]+:/i.test(filename)) return;
  const relative = filename.includes('/apps/api/src/') ? filename.split('/apps/api/src/').at(-1)!
    : filename.includes('/dist/') ? `dist/${filename.split('/dist/').at(-1)}` : filename;
  if (!sourceFiles.has(relative) && !/^dist\/(?:chunk-[A-Z0-9]{8}|server|ingress|ingress-worker)\.js$/.test(relative)) return;
  return { filename: relative, ...(positive(field(value, 'lineno')) ? { lineno: positive(field(value, 'lineno')) } : {}),
    ...(positive(field(value, 'colno')) ? { colno: positive(field(value, 'colno')) } : {}) };
}
function errorFrames(error: unknown): SafeFrame[] {
  const stack = field(error, 'stack');
  if (typeof stack !== 'string') return [];
  return stack.slice(0, 32_768).split('\n').slice(1, 65).flatMap(line => {
    const m = line.match(/(?:\(|\s)((?:file:\/\/\/|\/)?[^()\s]+):(\d+):(\d+)\)?$/);
    const frame = m && safeFrame({ filename: m[1], lineno: Number(m[2]), colno: Number(m[3]) });
    return frame ? [frame] : [];
  }).slice(0, contract.maxFrames);
}
function cause(error: unknown): SafeCause {
  const code = failureCode(error);
  const constructorName = field(field(error, 'constructor'), 'name');
  const name = field(error, 'name');
  return { type: typeOf(typeof name === 'string' && name !== 'Error' && contract.types.includes(name) ? name : constructorName), code, technical_cause: technicalCause(code), technical_summary: technicalSummary(code) };
}
export function describeFailure(point: FailurePoint, error: unknown, context: DiagnosticContext = {}): OperationalDiagnostic {
  const root = cause(error), causes: SafeCause[] = [], seen = new Set<unknown>([error]);
  let nested = field(error, 'causeError') ?? field(error, 'cause');
  while (nested && !seen.has(nested) && causes.length < contract.maxCauses) {
    seen.add(nested); causes.push(cause(nested)); nested = field(nested, 'causeError') ?? field(nested, 'cause');
  }
  return { version: 1, ...root, ...contract.operations[point], frames: errorFrames(error), causes,
    correlation_id: correlation(context.correlation_id), impact: root.code === 'OUTBOUND_UNCERTAIN' ? 'delivery_unconfirmed' : context.impact ?? 'unknown', recovery: 'unknown' };
}
export const diagnosticTags = (d: OperationalDiagnostic): Record<string, string> => ({
  diagnostic_version: '1', error_type: d.type, technical_cause: d.technical_cause,
  component: d.component, operation: d.operation, diagnostic_location: d.location,
  correlation_id: d.correlation_id, impact: d.impact, recovery: d.recovery,
  ...Object.fromEntries(d.frames.map((f, i) => [`diagnostic_frame_${i}`, `${f.filename}:${f.lineno ?? 0}:${f.colno ?? 0}`])),
  ...Object.fromEntries(d.causes.flatMap((c, i) => [[`cause_type_${i}`, c.type], [`cause_code_${i}`, c.code]]))
});

/** Second reconstruction, including for unhandled SDK exceptions and poisoned diagnostic tags. */
export function diagnosticFromEvent(point: FailurePoint, code: string, tags: Record<string, unknown>, original: unknown): OperationalDiagnostic {
  const d = describeFailure(point, { name: field(original, 'type'), message: field(original, 'value') });
  d.code = code; d.technical_cause = technicalCause(code); d.technical_summary = technicalSummary(code);
  const frames = field(field(original, 'stacktrace'), 'frames');
  d.frames = Array.isArray(frames) ? frames.flatMap(f => { const safe = safeFrame(f); return safe ? [safe] : []; }).slice(-contract.maxFrames).reverse() : [];
  if (tags.diagnostic_version !== '1') return d;
  d.type = typeOf(tags.error_type); d.correlation_id = correlation(tags.correlation_id);
  // Context is a fixed pair for the capture boundary, never caller-supplied free text.
  if (tags.component === contract.operations[point].component && tags.operation === contract.operations[point].operation) {
    d.component = tags.component; d.operation = tags.operation;
  }
  d.impact = typeof tags.impact === 'string' && contract.impacts.includes(tags.impact) ? tags.impact : 'unknown';
  d.frames = []; d.causes = [];
  for (let i = 0; i < contract.maxFrames; i++) {
    const text = tags[`diagnostic_frame_${i}`];
    const m = typeof text === 'string' && text.match(/^([^:]+):(\d+):(\d+)$/);
    const frame = m && safeFrame({ filename: m[1], lineno: Number(m[2]), colno: Number(m[3]) });
    if (frame) d.frames.push(frame);
  }
  for (let i = 0; i < contract.maxCauses; i++) {
    const type = tags[`cause_type_${i}`], nestedCode = tags[`cause_code_${i}`];
    if (typeof type === 'string' && contract.types.includes(type) && safeCode(nestedCode)) d.causes.push({ type: String(type), code: nestedCode, technical_cause: technicalCause(nestedCode), technical_summary: technicalSummary(nestedCode) });
  }
  return d;
}
