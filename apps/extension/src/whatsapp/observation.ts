import { messagePeer, ownAddress, parseAddress } from './identity';
import type { WaSelection } from '../protocol';
export type Observation = Omit<WaSelection, 'key'>;
export function observeWhatsApp(document: Document, storage: Pick<Storage, 'getItem'>): Observation {
  const main = document.querySelector('#main, [data-testid="conversation-panel-wrapper"]');
  const selfAddress = ownAddress(storage);
  const empty: Observation = { selfAddress, peerAddress: null, label: null, lastMessageId: null, phase: 'unidentified' };
  if (!document.querySelector('#side, [data-testid="chat-list"]')) return { ...empty, selfAddress: null, phase: 'signed_out' };
  if (!main || !selfAddress) return empty;
  const header = main.querySelector('header');
  const title = header?.querySelector('[data-testid="conversation-info-header-chat-title"], span[title]');
  const label = (title?.getAttribute('title') || title?.textContent)?.trim().slice(0, 160) || null;
  // Read identity attributes only: never scrape chat bodies, files, contact lists or QR/session credentials.
  const messageIds = Array.from(main.querySelectorAll('[data-id]')).slice(-200)
    .map(el => el.getAttribute('data-id')).filter((v): v is string => !!v && (!!messagePeer(v) || /^[A-Fa-f0-9]{16,64}$/.test(v)));
  const peers = new Set(messageIds.map(messagePeer).filter((v): v is string => !!v));
  if (peers.size > 1) return { ...empty, label };
  let peerAddress = peers.size === 1 ? [...peers][0]! : null;
  if (!peerAddress && messageIds.length) return { selfAddress, peerAddress: null, label, lastMessageId: messageIds.at(-1)!, phase: 'ready' };
  if (!peerAddress && label && /^\+?[\d\s().-]{8,25}$/.test(label)) peerAddress = parseAddress(`${label.replace(/\D/g, '')}@s.whatsapp.net`);
  if (!peerAddress) return { ...empty, label };
  if (peerAddress.endsWith('@g.us')) return { ...empty, label, phase: 'unsupported' };
  return { selfAddress, peerAddress, label, lastMessageId: messageIds.at(-1)?.slice(0, 250) ?? null, phase: 'ready' };
}

/** A click on the chat list immediately fences the old chat, even while its DOM remains on screen. */
export class SelectionTracker {
  private current: WaSelection;
  private pending: Observation | null = null;
  constructor(private read: () => Observation, private publish: (selection: WaSelection) => void,
    private newKey: () => string = () => crypto.randomUUID()) {
    this.current = { ...read(), key: newKey() };
  }
  get selection() { return this.current; }
  private emit(observation: Observation, force = false) {
    const { key: _key, ...old } = this.current;
    if (!force && JSON.stringify(old) === JSON.stringify(observation)) return;
    this.current = { ...observation, key: this.newKey() }; this.publish(this.current);
  }
  switching() {
    if (!this.pending) this.pending = this.read();
    this.emit({ selfAddress: null, peerAddress: null, label: null, lastMessageId: null, phase: 'switching' }, true);
  }
  refresh() {
    const next = this.read();
    if (!this.pending && this.current.phase === 'ready' && next.phase === 'ready'
      && next.label !== this.current.label && next.peerAddress === this.current.peerAddress) {
      this.pending = { ...this.current };
      this.emit({ selfAddress: null, peerAddress: null, label: null, lastMessageId: null, phase: 'switching' }, true);
      return;
    }
    if (this.pending) {
      if (next.phase === 'signed_out') this.pending = null;
      else if (next.phase !== 'ready') return;
      // Same peer after a navigation could still be the old message list. Never release it by time alone.
      else if (next.peerAddress === this.pending.peerAddress && next.selfAddress === this.pending.selfAddress
        && (next.peerAddress !== null || next.label === this.pending.label || next.lastMessageId === this.pending.lastMessageId)) return;
      else this.pending = null;
    }
    this.emit(next);
  }
  start() { this.publish(this.current); }
}
