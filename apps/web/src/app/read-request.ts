/** The deadline includes token acquisition, the response body and parsing. */
export async function withReadDeadline<T>(signal: AbortSignal | undefined, read: (signal: AbortSignal) => Promise<T>, timeoutMs = 8_000): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new DOMException('Requisição cancelada.', 'AbortError'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('O carregamento demorou demais. Tente novamente.', 'TimeoutError')), timeoutMs);
  try { controller.signal.throwIfAborted(); return await abortable(read(controller.signal), controller.signal); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class ReadAccessError extends Error {
  constructor(readonly status: number) { super('Seu acesso mudou. Entre novamente para continuar.'); }
}
const operationRefusalCodes = new Set([
  'SETTINGS_MANAGE_FORBIDDEN', 'AGENT_MANAGE_FORBIDDEN', 'AGENT_PACKAGE_MANAGE_FORBIDDEN',
  'TAG_MANAGE_FORBIDDEN', 'LEAD_MANAGE_FORBIDDEN', 'CRM_MANAGE_FORBIDDEN', 'TEAM_MANAGE_FORBIDDEN',
  'CAMPAIGN_MANAGE_FORBIDDEN', 'AUTOMATION_MANAGE_FORBIDDEN', 'FOLLOWUP_FORBIDDEN', 'CONVERSATION_RESET_FORBIDDEN'
]);
export async function assertReadAccess(response: Response, options: {
  signal?: AbortSignal;
  identityRead?: boolean;
  validateAccess?: () => Promise<Response>;
} = {}) {
  if (response.status !== 401 && response.status !== 403) return;
  const { signal, identityRead, validateAccess } = options;
  signal?.throwIfAborted();
  if (response.status === 403 && !identityRead) {
    let payload: unknown;
    try {
      const body = response.clone().json();
      payload = await (signal ? abortable(body, signal) : body);
    } catch { signal?.throwIfAborted(); }
    const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (typeof record.code === 'string' && operationRefusalCodes.has(record.code)) return;
    // These are the auth-context middleware's actual Fastify error contracts.
    const message = record.message ?? record.error;
    if (message !== 'Product access denied.' && message !== 'Workspace access denied.') {
      if (!validateAccess) return;
      const pending = validateAccess();
      const validation = await (signal ? abortable(pending, signal) : pending);
      if (validation.status !== 401 && validation.status !== 403) return;
    }
  }
  signal?.throwIfAborted();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('talk:access-revoked'));
  throw new ReadAccessError(response.status);
}
