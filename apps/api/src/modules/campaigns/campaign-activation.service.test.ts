import { describe, expect, it, vi } from 'vitest';
import { createCampaignActivationService } from './campaign-activation.service.js';

describe('campaign activation', () => {
  it('refuses a list created in Leads until its message is written', async () => {
    const prisma = { campaign: { findFirst: vi.fn(async () => ({ id: 'c', workspaceId: 'w', status: 'draft', messageBody: '', templates: [], prospectingAgentId: null, activationKey: null, cadence: {} })) } };
    const service = createCampaignActivationService(prisma as never);
    await expect(service.activate({ workspaceId: 'w', campaignId: 'c', actorId: 'u', idempotencyKey: 'k', channelId: 'ch', startMode: 'now', scheduledAt: null,
      timeZone: 'America/Sao_Paulo', confirmation: true, expectedAudienceHash: 'h', preview: { audienceHash: 'h', eligible: [{}], excluded: [], unresolvedVariables: [] } as never }))
      .rejects.toMatchObject({ code: 'CAMPAIGN_MESSAGE_REQUIRED', message: 'Escreva a mensagem do disparo antes de agendar.' });
  });
});
