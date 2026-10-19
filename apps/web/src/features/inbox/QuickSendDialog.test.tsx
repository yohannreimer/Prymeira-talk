import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChannelDto } from '@prymeira-talk/shared';
import { QuickSendDialog } from './QuickSendDialog';

const channel = (status: ChannelDto['status']): ChannelDto => ({
  id: 'channel-1', workspaceId: 'workspace-1', provider: 'evolution',
  providerKey: 'instance-1', phoneNumber: null, displayName: 'Diogo — Villefer',
  status, createdAt: '2026-09-25T12:00:00.000Z', updatedAt: '2026-09-25T12:00:00.000Z'
});

describe('QuickSendDialog channel availability', () => {
  const render = (status: ChannelDto['status']) => renderToStaticMarkup(
    <QuickSendDialog channels={[channel(status)]} getToken={async () => null} onClose={() => undefined} onSent={() => undefined} />
  );

  it('allows a connecting Evolution channel with a visible warning', () => {
    const html = render('connecting');
    expect(html).toContain('Diogo — Villefer · conexão não confirmada');
    expect(html).toContain('A conexão deste canal ainda não foi confirmada');
  });

  it('does not offer a disconnected channel for sending', () => {
    const html = render('disconnected');
    expect(html).not.toContain('Diogo — Villefer');
    expect(html).toContain('Conecte um canal WhatsApp Evolution');
  });
});
