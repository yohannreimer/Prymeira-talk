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
export function assertReadAccess(response: Response) {
  if (response.status !== 401 && response.status !== 403) return;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('talk:access-revoked'));
  throw new ReadAccessError(response.status);
}
