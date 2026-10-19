/** Pure decisions of the single outbound router: which physical connection writes, and what a failed
 * attempt means. No I/O here, so the rules that protect against duplicate sends are exhaustively testable.
 *
 * Invariants:
 * - Exactly one connection writes a given send; the other only receives.
 * - Fail over to the other connection ONLY when the failed attempt provably did not reach WhatsApp.
 * - When the outcome is uncertain (the request may have been delivered), never resend: the dispatch
 *   stays pending for review. A duplicated message to a customer is worse than a delayed one. */

export type ConnectionProvider = 'evolution' | 'waha';
export type ConnectionHealth = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

export interface RoutableConnection {
  id: string;
  provider: ConnectionProvider;
  status: string;
  health: ConnectionHealth;
  eligible: boolean;
  /** Same-number proof (verified phone equals the channel's other connection). */
  verifiedPhoneNumber: string | null;
  lastHealthyAt: Date | null;
  lifecycleGeneration?: number;
}

export interface RoutableChannel {
  redundancyEnabled: boolean;
  activeConnectionId: string | null;
  verifiedMessagingPhoneNumber?: string | null;
  connections: RoutableConnection[];
}

/** A connection may carry a new send only if it is connected, not unhealthy and (for the secondary) proven to
 * belong to the same number. */
export function canWrite(connection: RoutableConnection, channel: RoutableChannel) {
  if (connection.status !== 'connected' || connection.health === 'unhealthy' || !connection.eligible || (connection.lifecycleGeneration ?? 0) % 2 !== 0) return false;
  if (connection.provider === 'evolution') return !channel.verifiedMessagingPhoneNumber || connection.verifiedPhoneNumber === channel.verifiedMessagingPhoneNumber;
  if (!channel.redundancyEnabled || !connection.eligible) return false;
  const primary = channel.connections.find(candidate => candidate.provider === 'evolution');
  return !!connection.lastHealthyAt && !!connection.verifiedPhoneNumber && connection.verifiedPhoneNumber === (channel.verifiedMessagingPhoneNumber ?? primary?.verifiedPhoneNumber);
}

/** Writer for a NEW send. Prefers the channel's active writer; falls over to the other connection only if the
 * active one cannot write. Returns the ordered candidates (writer first, then the alternative). */
export function writerCandidates(channel: RoutableChannel): RoutableConnection[] {
  const writable = channel.connections.filter(connection => canWrite(connection, channel));
  const active = writable.find(connection => connection.id === channel.activeConnectionId);
  const others = writable.filter(connection => connection !== active);
  return [...(active ? [active] : []), ...others];
}

/** Logical availability uses the same identity and lifecycle fences as outbound routing.
 * A physical connected state without a writable session is never a connected channel. */
export function logicalChannelStatus(connections: RoutableConnection[], redundancyEnabled = true, verifiedMessagingPhoneNumber?: string | null) {
  if (!connections.length) return null;
  if (writerCandidates({ redundancyEnabled, activeConnectionId: null, verifiedMessagingPhoneNumber, connections }).length) return 'connected' as const;
  const primary = connections.find(connection => connection.provider === 'evolution');
  return primary && ['connecting', 'disconnected', 'failed'].includes(primary.status)
    ? primary.status as 'connecting' | 'disconnected' | 'failed' : 'disconnected' as const;
}

export type SendFailureClass =
  /** Provably not delivered: refused connection, unknown/closed session, authentication or validation error
   * answered before anything was handed to WhatsApp. Safe to try the other connection. */
  | 'not_delivered'
  /** The request may have reached WhatsApp (timeout, reset, 5xx, unreadable answer). Never resend. */
  | 'uncertain';

const NOT_DELIVERED_CODES = new Set(['EVOLUTION_UNAVAILABLE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
/** Provider texts that prove nothing could have been sent: the session/socket was not open. */
const NOT_SENT_TEXT = /connection closed|not connected|instance .*(does not exist|not found)|session .*(not found|stopped|failed|starting|scan_qr)|status is not as expected|logged out|not logged in/i;

/** `statusCode`: HTTP status when the provider answered; `code`: Node network error code when it did not.
 * `responseBody`/`message`: provider text, used only to recognise "the session was not open". */
export function classifySendFailure(error: unknown): SendFailureClass {
  const record = (typeof error === 'object' && error !== null ? error : {}) as { statusCode?: unknown; code?: unknown; cause?: unknown; name?: unknown; message?: unknown; responseBody?: unknown };
  const cause = (typeof record.cause === 'object' && record.cause !== null ? record.cause : {}) as { code?: unknown };
  const networkCode = typeof record.code === 'string' ? record.code : typeof cause.code === 'string' ? cause.code : null;
  if (networkCode && NOT_DELIVERED_CODES.has(networkCode)) return 'not_delivered';
  if (record.name === 'TimeoutError' || record.name === 'AbortError') return 'uncertain';
  const status = typeof record.statusCode === 'number' ? record.statusCode : null;
  if (status === null) return 'uncertain';
  // Client errors are answered before anything is handed to WhatsApp.
  if ([400, 401, 403, 404, 422].includes(status)) return 'not_delivered';
  // Server errors are ambiguous, unless the provider says the session was closed: then nothing could be sent.
  const text = `${String(record.message ?? '')} ${typeof record.responseBody === 'string' ? record.responseBody : JSON.stringify(record.responseBody ?? '')}`;
  return NOT_SENT_TEXT.test(text) ? 'not_delivered' : 'uncertain';
}

/** After a failover the original connection becomes the writer again only once it has been continuously healthy for
 * the whole `stableMs` (`healthySince` is when that unbroken period began, not the latest probe) and real events
 * seen by both connections agree (`eventsAgree`). */
export function shouldReturnToPrimary(input: { primary: RoutableConnection; healthySince: Date | null; now: Date; stableMs: number; eventsAgree: boolean; activeConnectionId: string | null }) {
  if (input.activeConnectionId === input.primary.id) return false;
  if (input.primary.status !== 'connected' || input.primary.health !== 'healthy' || !input.healthySince) return false;
  return input.eventsAgree && input.now.getTime() - input.healthySince.getTime() >= input.stableMs;
}
