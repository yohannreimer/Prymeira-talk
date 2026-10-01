import type { ChannelModel } from 'amqplib';
import type { Socket } from 'node:net';

const closing = new WeakMap<ChannelModel, Promise<void>>();
export const AMQP_CLOSE_DEADLINE_MS = 250;

/** amqplib 0.10.9 has no public force-close API. This narrow compatibility
 * boundary owns only this model's socket/heartbeat. A missing CloseOk must not
 * retain its TCP handle or block replacement. Never depend on close's callback:
 * amqplib can emit close on socket error without settling that callback. */
export function closeOwnedAmqpConnection(model: ChannelModel): Promise<void> {
  const previous = closing.get(model);
  if (previous) return previous;
  const connection = model.connection as typeof model.connection & {
    stream: Socket;
    heartbeater?: { clear(): void };
  };
  let settle!: () => void;
  const result = new Promise<void>(resolve => { settle = resolve; });
  closing.set(model, result);
  const stream = connection.stream;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    connection.heartbeater?.clear();
    model.removeListener('close', finish);
    stream.removeListener('close', finish);
    // CloseOk only ends the writable half; release the owned socket as well.
    if (!stream.destroyed) stream.destroy();
    settle();
  };
  const force = () => {
    if (finished) return;
    // Clear the library timer even when an earlier socket error has already
    // invalidated AMQP methods. Late close/error/confirm callbacks stay handled.
    connection.heartbeater?.clear();
    stream.destroy(new Error('Owned AMQP connection teardown deadline'));
    finish();
  };
  const deadline = setTimeout(force, AMQP_CLOSE_DEADLINE_MS);
  model.once('close', finish);
  stream.once('close', finish);
  if (stream.destroyed) { force(); return result; }
  try { void model.close().then(finish, force); } catch { force(); }
  return result;
}
