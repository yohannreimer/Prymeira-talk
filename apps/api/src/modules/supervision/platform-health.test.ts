import { describe, expect, it } from 'vitest';
import { assessChannel, type ChannelHealthView } from './platform-health.js';

const now = Date.parse('2026-10-05T16:00:00Z');
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const connection = (provider: 'evolution' | 'waha', over: Partial<ChannelHealthView['connections'][number]> = {}) => ({
  provider, status: 'connected', health: 'healthy', eligible: true, verifiedPhone: '554734353573', lastError: null,
  lastHealthyAt: at(0), lastCheckedAt: at(0), consecutiveFailures: 0, lastEventAt: at(0.1), events1h: 12, ...over });
const channel = (over: Partial<Omit<ChannelHealthView, 'level' | 'issues'>> = {}): Omit<ChannelHealthView, 'level' | 'issues'> => ({
  workspaceId: 'w', workspaceName: 'Villefer', channelId: 'c', name: 'Geral', phone: '554734353573', status: 'connected',
  connections: [connection('evolution'), connection('waha')],
  traffic: { lastInboundAt: at(0.2), lastOutboundAt: at(0.1), inbound1h: 4, inbound24h: 80, outbound24h: 60 },
  acks: { pending: 0, sent: 5, delivered: 30, read: 25, failed: 0 }, history: { status: 'completed', completedAt: at(30) }, ...over });

describe('number health', () => {
  it('is ok with both connections on the same phone, messages arriving and ticks coming back', () => {
    expect(assessChannel(channel(), now)).toEqual({ level: 'ok', issues: [] });
  });
  it('flags the Geral case: WAHA read with another phone is critical', () => {
    const result = assessChannel(channel({ connections: [connection('evolution'), connection('waha', { health: 'degraded', eligible: false, verifiedPhone: '554784986274', lastError: 'PHONE_MISMATCH' })] }), now);
    expect(result.level).toBe('critical');
    expect(result.issues.map(issue => issue.text)).toEqual([
      'WAHA foi lida com outro celular (número diferente do canal)',
      'Evolution e WAHA estão em celulares diferentes (554734353573 × 554784986274)'
    ]);
  });
  it('warns about a single connection, missing ticks and a silent number', () => {
    const result = assessChannel(channel({ connections: [connection('evolution')], traffic: { lastInboundAt: at(30), lastOutboundAt: at(1), inbound1h: 0, inbound24h: 0, outbound24h: 40 },
      acks: { pending: 0, sent: 38, delivered: 2, read: 0, failed: 0 } }), now);
    expect(result.level).toBe('warning');
    expect(result.issues.map(issue => issue.text)).toEqual(['Só uma conexão: falta conectar o WAHA', 'Nenhuma mensagem recebida há 30 h',
      'Confirmações de entrega não chegam (2 de 40 envios com ✓✓ em 24 h)']);
  });
  it('calls out a connection that stopped delivering events while the other one still does', () => {
    const result = assessChannel(channel({ connections: [connection('evolution', { lastEventAt: at(9) }), connection('waha')] }), now);
    expect(result.issues).toEqual([{ level: 'warning', text: 'Evolution não entrega eventos há 9 h' }]);
  });
  it('is critical when the channel or Evolution is down', () => {
    expect(assessChannel(channel({ status: 'disconnected', connections: [connection('evolution', { status: 'disconnected' })] }), now).issues.slice(0, 2).map(issue => issue.level))
      .toEqual(['critical', 'critical']);
  });
});
