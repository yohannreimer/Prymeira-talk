import amqp, { type ChannelModel } from 'amqplib';
import { closeOwnedAmqpConnection } from './connection-close.js';

export type SetupStep = <T>(operation: () => Promise<T>) => Promise<T>;

/** One wall-clock budget covers TCP, AMQP handshake and every setup RPC. The
 * socket's native AbortSignal owns cancellation even before amqplib exposes a
 * ChannelModel. Every continuation checks the same fence before starting work. */
export async function setupOwnedAmqpConnection<T>(url: string,
  options: { signal?: AbortSignal; setupDeadlineMs?: number },
  build: (model: ChannelModel, step: SetupStep) => Promise<T>): Promise<T> {
  const deadlineMs = options.setupDeadlineMs ?? 2000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 50 || deadlineMs > 30000) throw new Error('Invalid AMQP setup deadline');
  const owned = new AbortController();
  let model: ChannelModel | undefined;
  let rejectStop!: (reason: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  // A pre-aborted caller may stop before the first race is installed.
  void stopped.catch(() => {});
  const stop = (reason: Error) => {
    if (owned.signal.aborted) return;
    rejectStop(reason);
    owned.abort(reason); // destroys this attempt's socket, including mid-handshake
    if (model) void closeOwnedAmqpConnection(model);
  };
  const onAbort = () => stop(new Error('AMQP setup aborted'));
  const deadline = setTimeout(() => stop(new Error('AMQP setup deadline')), deadlineMs);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const step: SetupStep = async operation => {
    owned.signal.throwIfAborted();
    const result = await Promise.race([operation(), stopped]);
    owned.signal.throwIfAborted();
    return result;
  };
  try {
    await step(async () => {
      // amqplib passes socket options to net/tls.connect. Keep a handler on the
      // original promise: a late handshake must be owned and retired as well.
      model = await amqp.connect(url, { timeout: deadlineMs, signal: owned.signal });
      model.on('error', () => {});
      if (owned.signal.aborted) await closeOwnedAmqpConnection(model);
    });
    return await step(() => build(model!, step));
  } catch (error) {
    stop(error instanceof Error ? error : new Error('AMQP setup failed'));
    if (model) await closeOwnedAmqpConnection(model);
    throw error;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
