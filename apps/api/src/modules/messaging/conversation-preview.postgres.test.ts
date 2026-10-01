import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TrustedMessagingContext } from './normalized-event.js';
import { selectConversationPreviewInTransaction as select, refreshOwnedConversationPreviewInTransaction as refresh } from './conversation-preview.js';
const url = process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!url)('exact conversation preview ownership PostgreSQL', () => {
    let db: PrismaClient;
    const workspaces: string[] = [];
    beforeAll(() => { const u = new URL(url!); if (u.hostname !== '127.0.0.1' || u.port !== '55439' || u.pathname !== '/messaging_test')
        throw Error('owned messaging_test only'); db = new PrismaClient({ datasources: { db: { url } } }); });
    afterAll(async () => { await db.channel.deleteMany({ where: { workspaceId: { in: workspaces } } }); await db.contact.deleteMany({ where: { workspaceId: { in: workspaces } } }); await db.$disconnect(); });
    async function fixture() {
        const workspaceId = randomUUID();
        workspaces.push(workspaceId);
        const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
        const connection = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey } });
        const contact = await db.contact.create({ data: { workspaceId, phone: '15550001111' } });
        const conversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: contact.id, hiddenUntilReply: true } });
        const source: TrustedMessagingContext = { workspaceId, channelId: channel.id, provider: 'evolution', channelProvider: 'evolution', connectionId: connection.id, sessionName: connection.sessionName, lifecycleGeneration: 0, mode: 'live', observedAt: '2026-10-01T00:00:00Z' };
        const messages = await Promise.all(['first', 'second'].map(body => db.message.create({ data: { workspaceId, conversationId: conversation.id, direction: 'inbound', type: 'text', body, createdAt: new Date(1700000000000) } })));
        const input = (i: number, preview = messages[i]!.body) => ({ conversationId: conversation.id, messageId: messages[i]!.id, preview });
        const publish = (i: number, selection: 'new_message' | 'echo' = 'new_message') => db.$transaction(tx => select(tx, source, { ...input(i), selection }));
        const change = (i: number, preview: string) => db.$transaction(tx => refresh(tx, source, input(i, preview)));
        return { workspaceId, channel, connection, conversation, source, messages, input, publish, change };
    }
    it('only exact current owner may refresh equal-clock preview; echo cannot claim another UUID tie', async () => {
        const f = await fixture();
        await f.publish(0);
        await f.publish(1);
        expect(await f.change(0, 'wrong')).toBe(false);
        expect(await f.publish(0, 'echo')).toBe(false);
        expect(await f.change(1, 'current edited')).toBe(true);
        expect(await f.change(1, 'current edited')).toBe(true);
        expect(await db.conversation.findUnique({ where: { id: f.conversation.id } })).toMatchObject({ lastMessagePreview: 'current edited', lastMessagePreviewAt: f.messages[1]!.createdAt, lastMessageAt: null, hiddenUntilReply: true });
        expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: f.conversation.id } })).toMatchObject({ messageId: f.messages[1]!.id });
    });
    it.each(['same-preview', 'same-clock', 'different-preview'] as const)('any legacy UPDATE OF %s invalidates proof even if value stays identical', async (variant) => {
        const f = await fixture();
        await f.publish(0);
        await db.conversation.update({ where: { id: f.conversation.id }, data: variant === 'same-clock' ? { lastMessagePreviewAt: f.messages[0]!.createdAt } : { lastMessagePreview: variant === 'same-preview' ? 'first' : 'legacy' } });
        expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: f.conversation.id } })).toBeNull();
        expect(await f.change(0, 'wrong')).toBe(false);
        expect(await f.publish(1)).toBe(false);
        expect(await db.conversation.findUnique({ where: { id: f.conversation.id } })).toMatchObject({ lastMessagePreview: variant === 'different-preview' ? 'legacy' : 'first' });
    });
    it('unrelated legacy updates keep proof; genuinely newer message may establish new ownership', async () => {
        const f = await fixture();
        await f.publish(0);
        await db.conversation.update({ where: { id: f.conversation.id }, data: { unreadCount: 3, hiddenUntilReply: false } });
        expect(await f.change(0, 'owned')).toBe(true);
        await db.conversation.update({ where: { id: f.conversation.id }, data: { lastMessagePreview: 'legacy' } });
        await db.message.update({ where: { id: f.messages[1]!.id }, data: { createdAt: new Date(1700000001000) } });
        expect(await f.publish(1)).toBe(true);
        expect(await db.conversation.findUnique({ where: { id: f.conversation.id } })).toMatchObject({ lastMessagePreview: 'second', unreadCount: 3, hiddenUntilReply: false });
    });
    it.each(['older', 'equal', 'absent'] as const)('legacy preview without preview clock uses prior activity %s conservatively', async (activity) => {
        const f = await fixture();
        await db.conversation.update({ where: { id: f.conversation.id }, data: { lastMessagePreview: 'legacy', lastMessagePreviewAt: null, lastMessageAt: activity === 'absent' ? null : new Date(activity === 'older' ? 1699999999000 : 1700000000000) } });
        expect(await f.publish(1, 'echo')).toBe(activity === 'older');
        if (activity === 'older') {
            expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: f.conversation.id } })).toMatchObject({ messageId: f.messages[1]!.id });
            expect(await f.publish(0, 'echo')).toBe(false);
        }
        else {
            expect(await f.publish(1)).toBe(false);
            expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: f.conversation.id } })).toBeNull();
        }
        expect(await db.conversation.findUnique({ where: { id: f.conversation.id } })).toMatchObject({ lastMessagePreview: activity === 'older' ? 'second' : 'legacy', lastMessageAt: activity === 'absent' ? null : new Date(activity === 'older' ? 1699999999000 : 1700000000000), hiddenUntilReply: true });
    });
    it('concurrent selection and content refresh commit matching cache/owner under locks', async () => {
        const f = await fixture();
        await f.publish(0);
        await Promise.all([f.change(0, 'first edited'), f.publish(1)]);
        expect(await db.conversation.findUnique({ where: { id: f.conversation.id } })).toMatchObject({ lastMessagePreview: 'second' });
        expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: f.conversation.id } })).toMatchObject({ messageId: f.messages[1]!.id });
    });
    it('rollback restores both cache and original proof after an aborted selection', async () => {
        const f = await fixture();
        await f.publish(0);
        await expect(db.$transaction(async (tx) => { await select(tx, f.source, { ...f.input(1), selection: 'new_message' }); throw Error('synthetic rollback'); })).rejects.toThrow('synthetic rollback');
        expect(await db.conversation.findUnique({ where: { id: f.conversation.id } })).toMatchObject({ lastMessagePreview: 'first' });
        expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: f.conversation.id } })).toMatchObject({ messageId: f.messages[0]!.id });
    });
    it('scoped FK rejects foreign conversation/channel; proof deletion never deletes Message', async () => {
        const f = await fixture(), other = await fixture();
        await f.publish(0);
        await expect(db.conversationPreviewOwner.update({ where: { conversationId: f.conversation.id }, data: { messageId: other.messages[0]!.id } })).rejects.toThrow();
        await expect(db.conversationPreviewOwner.update({ where: { conversationId: f.conversation.id }, data: { channelId: other.channel.id } })).rejects.toThrow();
        await db.conversationPreviewOwner.delete({ where: { conversationId: f.conversation.id } });
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(2);
        await f.publish(0); // Existing equal-clock cache without proof stays conservative.
        expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: f.conversation.id } })).toBeNull();
        await db.conversation.update({ where: { id: f.conversation.id }, data: { lastMessagePreview: null, lastMessagePreviewAt: null } });
        await f.publish(0);
        await db.message.delete({ where: { id: f.messages[0]!.id } });
        expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: f.conversation.id } })).toBeNull();
        expect(await db.message.findUnique({ where: { id: f.messages[1]!.id } })).not.toBeNull();
    });
    it('stale lifecycle cannot touch cache or proof', async () => {
        const f = await fixture();
        await f.publish(0);
        await db.channelConnection.update({ where: { id: f.connection.id }, data: { lifecycleGeneration: 2 } });
        await expect(f.change(0, 'stale')).rejects.toMatchObject({ code: 'stale_source' });
        expect(await db.conversation.findUnique({ where: { id: f.conversation.id } })).toMatchObject({ lastMessagePreview: 'first' });
        expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: f.conversation.id } })).toMatchObject({ messageId: f.messages[0]!.id });
    });
});
