import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { canonicalPhone, ownAddress, parseAddress, messagePeer } from './identity';
import { observeWhatsApp, SelectionTracker, type Observation } from './observation';

const selfAddress = '5547991234567@s.whatsapp.net', peerAddress = '5547987654321@s.whatsapp.net';
const storage = { getItem: (key: string) => key === 'last-wid-md' ? JSON.stringify('5547991234567:8@c.us') : null };
function dom(contents: string) { return new JSDOM(`<div id="side"></div><div id="main"><header><span title="Ana">Ana</span></header>${contents}</div>`).window.document; }
function ready(peer = peerAddress, label = 'Ana'): Observation { return { selfAddress, peerAddress: peer, label, lastMessageId: `false_${peer}_stanza`, phase: 'ready' }; }
describe('WhatsApp identity adapter', () => {
  it('keeps LID separate from phone and normalizes device suffixes', () => {
    expect(parseAddress('"5547991234567:8@c.us"')).toBe(selfAddress);
    expect(parseAddress('123456789@lid')).toBe('123456789@lid');
    expect(messagePeer('false_123456789@lid_raw_with_underscores')).toBe('123456789@lid');
    expect(parseAddress('Ana 5547991234567')).toBeNull();
    expect(parseAddress('status@broadcast')).toBeNull();
    expect(canonicalPhone(selfAddress)).toBe('554791234567');
    expect(canonicalPhone('+55 (47) 99123-4567')).toBe('554791234567');
  });
  it('reads only the two identity keys and refuses contradictory accounts', () => {
    expect(ownAddress(storage)).toBe(selfAddress);
    expect(ownAddress({ getItem: key => key === 'last-wid' ? '5511987654321@c.us' : '5547991234567@c.us' })).toBeNull();
  });
  it('identifies a named chat using message identity, without reading its text', () => {
    const observed = observeWhatsApp(dom(`<div data-id="false_${peerAddress}_stanza">Private body is irrelevant</div>`), storage);
    expect(observed).toMatchObject({ phase: 'ready', peerAddress, label: 'Ana', lastMessageId: `false_${peerAddress}_stanza` });
    expect(JSON.stringify(observed)).not.toContain('Private body');
  });
  it('refuses mixed chats, group chats and names without identity', () => {
    expect(observeWhatsApp(dom(`<div data-id="false_${peerAddress}_1"></div><div data-id="true_5511998765432@c.us_2"></div>`), storage).phase).toBe('unidentified');
    expect(observeWhatsApp(dom('<div data-id="false_123456-789@g.us_1"></div>'), storage).phase).toBe('unsupported');
    expect(observeWhatsApp(dom(''), storage).peerAddress).toBeNull();
  });
  it('clears identity on logout even when localStorage still contains the last number', () => {
    expect(observeWhatsApp(new JSDOM('<div>QR</div>').window.document, storage)).toMatchObject({ phase: 'signed_out', selfAddress: null, peerAddress: null });
  });
  it('can identify a new direct conversation from a strictly numeric header', () => {
    const document = dom(''); document.querySelector('span')!.setAttribute('title', '+55 (47) 98765-4321');
    expect(observeWhatsApp(document, storage).peerAddress).toBe(peerAddress);
  });
});
describe('selection navigation fence', () => {
  it('never releases the old message list by elapsed time after a click', () => {
    let current = ready(); const events: unknown[] = []; let generation = 0;
    const tracker = new SelectionTracker(() => current, s => events.push(s), () => `key-${++generation}`);
    tracker.start(); tracker.switching();
    for (let i = 0; i < 20; i++) tracker.refresh();
    expect(tracker.selection.phase).toBe('switching');
    current = ready('5511998765432@s.whatsapp.net', 'João'); tracker.refresh();
    expect(tracker.selection).toMatchObject({ phase: 'ready', label: 'João' });
    expect(events).toHaveLength(3);
  });
  it('invalidates when a header changes before the message list', () => {
    let current = ready(); const tracker = new SelectionTracker(() => current, () => {}, () => 'key');
    current = ready(peerAddress, 'João'); tracker.refresh();
    expect(tracker.selection.phase).toBe('switching');
    current = ready('5511998765432@s.whatsapp.net', 'João'); tracker.refresh();
    expect(tracker.selection.phase).toBe('ready');
  });
  it('issues a new key when a new message arrives in the same conversation', () => {
    let current = ready(), generation = 0;
    const tracker = new SelectionTracker(() => current, () => {}, () => `key-${++generation}`);
    const old = tracker.selection.key; current = { ...current, lastMessageId: `false_${peerAddress}_new` }; tracker.refresh();
    expect(tracker.selection.key).not.toBe(old);
  });
  it('same-name contacts still switch by identity and logout clears pending navigation', () => {
    let current = ready(); const tracker = new SelectionTracker(() => current, () => {}, () => 'key');
    tracker.switching(); current = ready('5511998765432@s.whatsapp.net', 'Ana'); tracker.refresh();
    expect(tracker.selection.peerAddress).toBe('5511998765432@s.whatsapp.net');
    tracker.switching(); current = { ...current, phase: 'signed_out', selfAddress: null, peerAddress: null }; tracker.refresh();
    expect(tracker.selection.phase).toBe('signed_out');
  });
});
