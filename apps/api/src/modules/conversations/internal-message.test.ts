import { describe, expect, it } from 'vitest';
import { visibleConversationMessageWhere, withoutInternalFollowupReservations } from './internal-message.js';

describe('reset visibility alongside internal reservations', () => {
  it('requires visibility without changing the pending followup exclusion', () => {
    expect(visibleConversationMessageWhere({ workspaceId: 'w', conversationId: 'c' })).toEqual({
      workspaceId: 'w', conversationId: 'c', hiddenByReset: false,
      NOT: { status: 'pending', metadata: { path: ['source'], equals: 'followup_review' } }
    });
  });
  it('filters reset history while retaining followup and campaign duplicate exclusions', () => {
    const visible = { id: 'visible', status: 'delivered', hiddenByReset: false, metadata: {} };
    const hidden = { ...visible, id: 'hidden', hiddenByReset: true };
    const followup = { ...visible, id: 'followup', status: 'pending', metadata: { source: 'followup_review', followupId: 'f' } };
    const duplicate = { ...visible, id: 'duplicate', metadata: { campaignDuplicateAudit: true } };
    expect(withoutInternalFollowupReservations([visible, hidden, followup, duplicate])).toEqual([visible]);
  });
});
