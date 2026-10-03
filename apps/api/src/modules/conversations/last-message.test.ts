import { describe, expect, it, vi } from "vitest";
import { conversationSchema, type ConversationDto } from "@prymeira-talk/shared";
import { withLastMessages } from "./conversations.service.js";

const dto = (id: string): ConversationDto => ({ id, workspaceId: 'w', channelId: 'ch', contactId: `ct-${id}`, status: 'open', assignedUserId: null,
  departmentId: null, lastMessageAt: '2026-10-03T12:00:00.000Z', lastMessagePreview: 'oi', unreadCount: 0, priority: 'normal' });

describe('withLastMessages (queue card ticks)', () => {
  it('adds each conversation latest message in one query, null when it has none, and stays schema-valid', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([
      { conversation_id: 'c1', id: 'm1', direction: 'outbound', status: 'read', created_at: new Date('2026-10-03T12:00:00Z') }
    ]);
    const result = await withLastMessages({ $queryRaw } as never, 'w', [dto('c1'), dto('c2')]);
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(result[0]!.lastMessage).toEqual({ id: 'm1', direction: 'outbound', status: 'read', createdAt: '2026-10-03T12:00:00.000Z' });
    expect(result[1]!.lastMessage).toBeNull();
    for (const row of result) expect(conversationSchema.parse(row)).toBeTruthy();
  });
  it('never breaks the inbox: no query for an empty page, and the cards stay as they were if the query fails', async () => {
    const $queryRaw = vi.fn().mockRejectedValue(new Error('boom'));
    expect(await withLastMessages({ $queryRaw } as never, 'w', [])).toEqual([]);
    const rows = [dto('c1')];
    expect(await withLastMessages({ $queryRaw } as never, 'w', rows)).toBe(rows);
    expect(await withLastMessages({} as never, 'w', rows)).toBe(rows);
  });
});
