import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedMessagingEvent, TrustedMessagingContext } from './normalized-event.js';
import { parseWahaMessageKey } from './whatsapp-identity.js';
import { createCanonicalStore, type CanonicalStoreOptions } from './canonical-store.js';

const url = process.env.MESSAGING_TEST_DATABASE_URL;
const PN = '15550001111@s.whatsapp.net', LID = '700001@lid', GROUP = '120000-100@g.us';
type MessageEvent = Extract<NormalizedMessagingEvent, { kind: 'message' }>;
function msg(context: TrustedMessagingContext, rawId = 'A', chat = PN, sender?: string): MessageEvent {
  return { kind: 'message', context, providerEventId: null, providerEventType: 'message', addressMappings: [],
    key: { ...parseWahaMessageKey({ id: rawId, remote: chat, fromMe: false, participant: sender }), nativeId: context.provider === 'waha' ? `false_${chat}_${rawId}` : rawId },
    content: { type: 'text', body: 'hello', mediaUrl: null, preview: 'hello' }, attachment: {}, media: null,
    currentRevision: null, pushName: 'Fixture', source: null, order: { timestampMs: 1700000000000, sequence: null } };
}

describe.skipIf(!url)('canonical transactional store on PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  const store = createCanonicalStore();
  async function context(workspaceId: string = randomUUID(), channelId?: string, provider: 'evolution' | 'waha' = 'evolution'): Promise<Extract<TrustedMessagingContext, { channelProvider: 'evolution' }>> {
    if (!workspaces.includes(workspaceId)) workspaces.push(workspaceId);
    const channel = channelId ? await db.channel.findUniqueOrThrow({ where: { id: channelId } }) : await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const connection = await db.channelConnection.upsert({ where: { workspaceId_channelId_provider: { workspaceId, channelId: channel.id, provider } }, create: { workspaceId, channelId: channel.id, provider, sessionName: randomUUID() }, update: {} });
    return { workspaceId, channelId: channel.id, provider, channelProvider: 'evolution', connectionId: connection.id, sessionName: connection.sessionName, lifecycleGeneration: 0, mode: 'live', observedAt: '2026-09-30T12:00:00.000Z' };
  }
  const persist = (event: NormalizedMessagingEvent, receiptKey: string = randomUUID(), options: Omit<Partial<CanonicalStoreOptions>, 'receiptKey'> = {}) => store.persist(db, event, { receiptKey, ...options });
  beforeAll(() => {
    const u = new URL(url!);
    if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['localhost','127.0.0.1'].includes(u.hostname) || u.pathname !== '/messaging_test') throw new Error('Only local messaging_test');
    db = new PrismaClient({ datasources: { db: { url } } });
  });
  afterAll(async () => {
    if (!db) return;
    // All cleanup is restricted to fixture workspace UUIDs.
    const where = { workspaceId: { in: workspaces } };
    await db.canonicalAction.deleteMany({ where });
    await db.canonicalRecipientReceipt.deleteMany({ where });
    await db.canonicalAddressEvidence.deleteMany({ where });
    await db.canonicalObservation.deleteMany({ where });
    await db.canonicalNativeAlias.deleteMany({ where });
    await db.canonicalMessageIdentity.deleteMany({ where });
    await db.canonicalChatMember.deleteMany({ where });
    await db.canonicalChat.deleteMany({ where });
    await db.canonicalAddressAlias.deleteMany({ where });
    await db.canonicalAddress.updateMany({ where, data: { redirectId: null } });
    await db.canonicalAddress.deleteMany({ where });
    await db.integrationConfig.deleteMany({ where });
    await db.channel.deleteMany({ where });
    await db.contact.deleteMany({ where });
    await db.$disconnect();
  });
  it('serializes mirrored workers before creating records and writes effects inside the same transaction', async () => {
    const a = await context(), b = await context(a.workspaceId, a.channelId, 'waha');
    const outputs = await Promise.all(Array.from({ length: 8 }, (_, n) => db.$transaction(async tx => {
      const result = await store.persistInTransaction(tx, msg(n % 2 ? a : b), { receiptKey: `delivery-${n}` });
      if (result.allowOperationalEffects) await tx.conversation.update({ where: { id: result.conversationId! }, data: { unreadCount: { increment: 1 } } });
      return result;
    })));
    expect(outputs.filter(r => r.outcome === 'created')).toHaveLength(1);
    expect(new Set(outputs.map(r => r.messageId)).size).toBe(1);
    expect(await db.message.count({ where: { workspaceId: a.workspaceId } })).toBe(1);
    expect(await db.contact.count({ where: { workspaceId: a.workspaceId } })).toBe(1);
    expect(await db.conversation.findFirst({ where: { workspaceId: a.workspaceId } })).toMatchObject({ unreadCount: 1 });
    expect(await db.canonicalObservation.count({ where: { workspaceId: a.workspaceId } })).toBe(8);
    expect(await db.canonicalNativeAlias.count({ where: { workspaceId: a.workspaceId } })).toBe(2);
  });
  it('rolls back message, observation, contact and real effects together', async () => {
    const c = await context();
    await expect(db.$transaction(async tx => {
      const result = await store.persistInTransaction(tx, msg(c), { receiptKey: 'rollback' });
      await tx.conversation.update({ where: { id: result.conversationId! }, data: { unreadCount: { increment: 1 } } });
      throw new Error('caller failed');
    })).rejects.toThrow('caller failed');
    for (const count of [await db.contact.count({ where: { workspaceId: c.workspaceId } }), await db.message.count({ where: { workspaceId: c.workspaceId } }), await db.canonicalObservation.count({ where: { workspaceId: c.workspaceId } })]) expect(count).toBe(0);
    expect((await persist(msg(c), 'rollback')).outcome).toBe('created');
  });
  it('preserves receipt identity and never grants effects on retries', async () => {
    const c = await context(), first = await persist(msg(c), 'same');
    const second = await persist({ ...msg(c), context: { ...c, observedAt: '2026-09-30T13:00:00Z' } }, 'same');
    expect(second).toMatchObject({ outcome: 'duplicate', observationId: first.observationId, messageId: first.messageId, allowOperationalEffects: false });
    expect(await db.canonicalObservation.count({ where: { workspaceId: c.workspaceId } })).toBe(1);
  });
  it('saves malformed display text without losing valid emoji or changing message identity on redelivery', async () => {
    const c = await context(), event = msg(c, 'unicode-fixture');
    event.content.body = event.content.preview = 'Olá 🧑🏽‍💻 \ud800 X \udfff';
    event.pushName = 'Cliente \ud800';
    const original = structuredClone(event);
    const first = await persist(event, 'unicode-receipt');
    expect(first.outcome).toBe('created');
    expect(await db.message.findUniqueOrThrow({ where: { id: first.messageId! } })).toMatchObject({ body: 'Olá 🧑🏽‍💻 � X �' });
    const observation = await db.canonicalObservation.findUniqueOrThrow({ where: { id: first.observationId } });
    expect(observation.payload).toMatchObject({ content: { body: 'Olá 🧑🏽‍💻 � X �' }, key: event.key });
    expect(await persist(event, 'unicode-receipt')).toMatchObject({ outcome: 'duplicate', observationId: first.observationId, messageId: first.messageId });
    expect(event).toEqual(original);
  });
  it('compares full tuples even when every hash collides and accepts arbitrarily long native IDs', async () => {
    const c = await context(), collisionStore = createCanonicalStore({ hash: () => '0'.repeat(64) });
    const a = await collisionStore.persist(db, msg(c, 'X'.repeat(12000)), { receiptKey: 'Y'.repeat(12000) });
    const b = await collisionStore.persist(db, msg(c, 'B'), { receiptKey: 'different' });
    const mirror = await collisionStore.persist(db, msg(c, 'B'), { receiptKey: 'another' });
    expect(a.outcome).toBe('created'); expect(b.outcome).toBe('created'); expect(mirror.messageId).toBe(b.messageId);
    expect(a.messageId).not.toBe(b.messageId);
  });
  it('isolates the same stanza by tenant, channel, chat, direction and group sender', async () => {
    const a = await context(), b = await context(a.workspaceId), c = await context();
    const outbound = msg(a); outbound.key.direction = 'outbound';
    const values = [msg(a), msg(b), msg(c), msg(a,'A','15550002222@s.whatsapp.net'), outbound, msg(a,'A',GROUP,PN), msg(a,'A',GROUP,'15550002222@s.whatsapp.net')];
    const results = []; for (const value of values) results.push(await persist(value));
    expect(results.every(r => r.outcome === 'created')).toBe(true);
    expect(new Set(results.map(r => r.messageId)).size).toBe(7);
    expect(await db.message.findMany({ where: { workspaceId: a.workspaceId }, select: { providerMessageId: true, providerEventId: true } })).toEqual(expect.arrayContaining([{ providerMessageId: null, providerEventId: null }]));
    expect(await db.contact.count({ where: { workspaceId: a.workspaceId } })).toBe(3);
  });
  it('shares a new Contact across concurrent channels of one workspace', async () => {
    const a = await context(), b = await context(a.workspaceId);
    await Promise.all([persist(msg(a)), persist(msg(b))]);
    expect(await db.contact.count({ where: { workspaceId: a.workspaceId } })).toBe(1);
    expect(await db.conversation.count({ where: { workspaceId: a.workspaceId } })).toBe(2);
  });
  it('uses explicit late PN/LID proof to find the first Message without creating a second effect', async () => {
    const c = await context(); const first = await persist(msg(c,'A',LID));
    const mirror = msg(c); mirror.addressMappings = [{ role: 'chat', lid: LID, pn: PN, source: 'evolution.remoteJidAlt' }];
    const result = await persist(mirror);
    expect(result).toMatchObject({ messageId: first.messageId, conversationId: first.conversationId, allowOperationalEffects: false });
    expect(await db.message.count({ where: { workspaceId: c.workspaceId } })).toBe(1);
    expect(await db.canonicalAddressEvidence.count({ where: { workspaceId: c.workspaceId } })).toBe(1);
  });
  it('reuses the only existing conversation even when two PN/LID contacts already exist', async () => {
    const c = await context();
    await db.contact.create({ data: { workspaceId: c.workspaceId, phone: '15550001111' } });
    const lidContact = await db.contact.create({ data: { workspaceId: c.workspaceId, phone: LID } });
    const conversation = await db.conversation.create({ data: { workspaceId: c.workspaceId, channelId: c.channelId, contactId: lidContact.id, unreadCount: 5, aiControlStatus: 'human_controlled' } });
    const event = msg(c); event.addressMappings = [{ role:'chat', lid:LID, pn:PN, source:'evolution.remoteJidAlt' }];
    expect(await persist(event)).toMatchObject({ outcome:'created', conversationId:conversation.id });
    expect(await db.conversation.count({ where: { workspaceId: c.workspaceId } })).toBe(1);
    expect(await db.conversation.findUnique({ where: { id: conversation.id } })).toMatchObject({ unreadCount:5, aiControlStatus:'human_controlled', contactId:lidContact.id });
  });
  it('holds two conversation authorities and still resolves that address as a group sender', async () => {
    const c = await context(); const pn = await persist(msg(c,'P')); const lid = await persist(msg(c,'L',LID));
    const event = msg(c,'NEW'); event.addressMappings = [{ role:'chat', lid:LID, pn:PN, source:'evolution.remoteJidAlt' }];
    const held = await persist(event);
    expect(held).toMatchObject({ outcome:'held', conversationId:null, allowOperationalEffects:false });
    expect(held.reconciliationReasons).toContain('multiple_conversation_authorities');
    expect(await db.canonicalChat.findUnique({ where: { id: held.chatId! } })).toMatchObject({ state:'review', operationConversationId:null });
    const group = await persist(msg(c,'GROUP',GROUP,LID));
    const mirror = await persist(msg(c,'GROUP',GROUP,PN));
    expect(group.outcome).toBe('created'); expect(mirror.messageId).toBe(group.messageId);
    expect((await db.message.findUniqueOrThrow({ where:{id:pn.messageId!} })).conversationId).toBe(pn.conversationId);
    expect((await db.message.findUniqueOrThrow({ where:{id:lid.messageId!} })).conversationId).toBe(lid.conversationId);
  });
  it('holds late duplicate identities without deleting or relocating existing messages', async () => {
    const c = await context(); const a = await persist(msg(c,'A',GROUP,LID)); const b = await persist(msg(c,'A',GROUP,PN));
    const event = msg(c,'A',GROUP,PN); event.addressMappings = [{role:'sender',lid:LID,pn:PN,source:'evolution.participantAlt'}];
    const result = await persist(event);
    expect(result).toMatchObject({outcome:'held',allowOperationalEffects:false});
    expect(result.reconciliationReasons).toContain('multiple_message_identities');
    expect(result.conflictingMessageIds?.sort()).toEqual([a.messageId,b.messageId].sort());
    expect(await db.message.count({where:{workspaceId:c.workspaceId}})).toBe(2);
  });
  it('keeps incomplete group identity and all actions held without creating records or effects', async () => {
    const c = await context(), incomplete = msg(c,'A',GROUP);
    expect(await persist(incomplete)).toMatchObject({outcome:'held',messageId:null,allowOperationalEffects:false});
    const base = msg(c);
    const actions: NormalizedMessagingEvent[] = [
      { ...base, kind:'revoke',target:base.key,action:base.key },
      { ...base, kind:'edit',target:base.key,action:base.key,patch:{field:'caption',caption:''} },
      { ...base, kind:'receipt',target:base.key,status:'read',providerStatus:3,recipient:PN },
      { ...base, kind:'encrypted_edit',target:base.key,action:base.key,encrypted:{ivBase64:'aXY=',payloadBase64:'c2VjcmV0',senderJids:[PN]} }
    ];
    for (const action of actions) expect(await persist(action)).toMatchObject({outcome:'held',allowOperationalEffects:false});
    expect(await db.message.count({where:{workspaceId:c.workspaceId}})).toBe(0);
    expect(await db.contact.count({where:{workspaceId:c.workspaceId}})).toBe(0);
    expect(await db.canonicalObservation.count({where:{workspaceId:c.workspaceId,state:'held'}})).toBe(5);
  });
  it('keeps provider-native identities separate from stanza identity', async () => {
    const c = await context(), w = await context(c.workspaceId,c.channelId,'waha');
    const native = msg(c,'wamid.A'); native.key.identityFormat='provider_native';native.key.rawId=null;
    const other = {...native,context:w};
    const results = [await persist(native),await persist(other),await persist(msg(c,'wamid.A'))];
    expect(new Set(results.map(r=>r.messageId)).size).toBe(3);
  });
  it('adopts a demonstrated legacy Message UUID and preserves prepared media, time and native IDs', async () => {
    const c = await context();
    const contact = await db.contact.create({data:{workspaceId:c.workspaceId,phone:'15550001111'}});
    const conversation = await db.conversation.create({data:{workspaceId:c.workspaceId,channelId:c.channelId,contactId:contact.id}});
    const existing = await db.message.create({data:{workspaceId:c.workspaceId,conversationId:conversation.id,direction:'inbound',type:'audio',body:'prepared transcript',mediaUrl:'https://owned.test/a',metadata:{transcription:{status:'completed'},editedAt:'2026-09-01'},providerMessageId:'A',createdAt:new Date('2026-09-01')}});
    const legacyAlias = await db.canonicalNativeAlias.create({data:{workspaceId:c.workspaceId,channelId:c.channelId,channelProvider:'evolution',provider:'evolution',tupleHash:'abcd',fullTuple:{origin:'legacy',messageId:existing.id,conversationId:conversation.id,nativeId:'A',direction:'inbound'}}});
    const event = msg(c); event.content.type='audio';event.content.body='original';event.content.mediaUrl='https://provider.test/a';
    const result = await persist(event,'adopt',{adoption:{messageId:existing.id,key:event.key,source:'provider_exact_lookup'}});
    expect(result).toMatchObject({outcome:'enriched',messageId:existing.id,allowOperationalEffects:false});
    expect(await db.canonicalNativeAlias.findUnique({where:{id:legacyAlias.id}})).toMatchObject({state:'resolved',identityId:result.identityId});
    const after = await db.message.findUniqueOrThrow({where:{id:existing.id}});
    expect(after).toMatchObject({body:existing.body,type:existing.type,mediaUrl:existing.mediaUrl,metadata:existing.metadata,providerMessageId:'A',createdAt:existing.createdAt});
  });
  it('keeps history inert and requires explicit eligibility for newly recovered live events', async () => {
    const c = await context(); const history = await persist(msg({...c,mode:'history'}),'history');
    expect(history.allowOperationalEffects).toBe(false);
    expect((await persist(msg(c),'live')).allowOperationalEffects).toBe(false);
    expect((await persist(msg({...c,mode:'recovered_live'},'B'))).allowOperationalEffects).toBe(false);
    expect((await persist(msg({...c,mode:'recovered_live'},'C'),'recovered',{recoveredLiveEligible:true})).allowOperationalEffects).toBe(true);
  });
  it('rejects wrong tenant/channel/connection before creating domain records', async () => {
    const a = await context(), b = await context();
    await expect(persist(msg({...a,connectionId:b.connectionId!}))).rejects.toThrow('scope');
    expect(await db.message.count({where:{workspaceId:a.workspaceId}})).toBe(0);
  });
  it('holds reuse of an event receipt with different content rather than losing the conflict', async () => {
    const c = await context(); const original = msg(c); await persist(original,'receipt');
    const changed = msg(c); changed.content.body='different';
    expect(await persist(changed,'receipt')).toMatchObject({outcome:'held',allowOperationalEffects:false,reconciliationReasons:['receipt_key_conflict']});
  });
  it('requires exact adoption when a scoped legacy native ID already exists', async () => {
    const c=await context();
    const contact=await db.contact.create({data:{workspaceId:c.workspaceId,phone:'15550001111'}});
    const conversation=await db.conversation.create({data:{workspaceId:c.workspaceId,channelId:c.channelId,contactId:contact.id}});
    const legacy=await db.message.create({data:{workspaceId:c.workspaceId,conversationId:conversation.id,direction:'inbound',type:'text',body:'old',providerMessageId:'A'}});
    expect(await persist(msg(c))).toMatchObject({outcome:'held',allowOperationalEffects:false,reconciliationReasons:['legacy_identity_requires_adoption']});
    expect(await db.message.count({where:{workspaceId:c.workspaceId}})).toBe(1);
    expect((await db.message.findUniqueOrThrow({where:{id:legacy.id}})).body).toBe('old');
  });
  it('enriches only absent fields with the same revision, preserving prepared fields and tombstones', async () => {
    const c=await context(), first=msg(c); first.content.body=null;
    const original=await persist(first); const enriched=await persist(msg(c));
    expect(enriched.outcome).toBe('enriched');
    expect((await db.message.findUniqueOrThrow({where:{id:original.messageId!}})).body).toBe('hello');
    await db.message.update({where:{id:original.messageId!},data:{type:'system',body:'deleted',metadata:{deletedAt:'2026-09-01'},mediaUrl:null,status:'read'}});
    const mirror=msg(c);mirror.content.mediaUrl='https://provider.test/media';
    await persist(mirror);
    expect(await db.message.findUnique({where:{id:original.messageId!}})).toMatchObject({type:'system',body:'deleted',mediaUrl:null,status:'read'});
    const audio=msg(c,'B');audio.content.type='audio';audio.content.mediaUrl=null;
    const created=await persist(audio);
    await db.message.update({where:{id:created.messageId!},data:{body:'transcript',metadata:{transcription:{status:'completed'}}}});
    const editedMirror={...audio,currentRevision:msg(c,'EDIT').key,content:{...audio.content,mediaUrl:'https://provider.test/audio'}};
    expect((await persist(editedMirror)).reconciliationReasons).toContain('revision_reconciliation_required');
    expect(await db.message.findUnique({where:{id:created.messageId!}})).toMatchObject({body:'transcript',type:'audio',mediaUrl:null});
  });
  it('coalesces duplicate proof entries inside the same observation', async () => {
    const c=await context(), event=msg(c);
    const proof={role:'chat' as const,lid:LID,pn:PN,source:'evolution.remoteJidAlt' as const};event.addressMappings=[proof,proof];
    expect((await persist(event)).outcome).toBe('created');
    expect(await db.canonicalAddressEvidence.count({where:{workspaceId:c.workspaceId}})).toBe(1);
  });
  it('rejects cross-scope composite FKs even for direct database writes', async () => {
    const a=await context(), b=await context(); const saved=await persist(msg(a));
    const identity=await db.canonicalMessageIdentity.findUniqueOrThrow({where:{id:saved.identityId!}});
    await expect(db.canonicalAddress.create({data:{workspaceId:b.workspaceId,channelId:a.channelId}})).rejects.toMatchObject({code:'P2003'});
    await expect(db.canonicalChatMember.create({data:{workspaceId:b.workspaceId,channelId:b.channelId,chatId:saved.chatId!,conversationId:saved.conversationId!,source:'invalid'}})).rejects.toMatchObject({code:'P2003'});
    const other=await persist(msg(b));
    await expect(db.canonicalMessageIdentity.update({where:{id:identity.id},data:{conversationId:other.conversationId!}})).rejects.toMatchObject({code:'P2003'});
    const obs=await db.canonicalObservation.findUniqueOrThrow({where:{id:saved.observationId}});
    await expect(db.canonicalObservation.update({where:{id:obs.id},data:{connectionId:b.connectionId}})).rejects.toMatchObject({code:'P2003'});
    await expect(db.canonicalObservation.update({where:{id:obs.id},data:{identityId:other.identityId}})).rejects.toMatchObject({code:'P2003'});
    const alias=await db.canonicalNativeAlias.findFirstOrThrow({where:{workspaceId:a.workspaceId}});
    await expect(db.canonicalNativeAlias.update({where:{id:alias.id},data:{connectionId:b.connectionId}})).rejects.toMatchObject({code:'P2003'});
  });
  it('rejects physical WAHA on Meta at both API and database layers', async () => {
    const a=await context();
    const channel=await db.channel.create({data:{workspaceId:a.workspaceId,provider:'meta_cloud',providerKey:randomUUID()}});
    const physical=await db.channelConnection.create({data:{workspaceId:a.workspaceId,channelId:channel.id,provider:'waha',sessionName:randomUUID()}});
    const c={...a,provider:'waha',channelProvider:'meta',channelId:channel.id,connectionId:physical.id} as unknown as TrustedMessagingContext;
    await expect(persist(msg(c))).rejects.toThrow('WAHA scope');
    await expect(db.canonicalNativeAlias.create({data:{workspaceId:c.workspaceId,channelId:c.channelId,channelProvider:'meta_cloud',provider:'waha',connectionProvider:'waha',connectionId:physical.id,tupleHash:'1',fullTuple:[]}})).rejects.toThrow();
  });

  it('holds contradictory PN/LID proof and subsequent messages on the disputed address', async () => {
    const c=await context(), initial=msg(c,'A',LID);
    initial.addressMappings=[{role:'chat',lid:LID,pn:PN,source:'evolution.remoteJidAlt'}];
    await persist(initial);
    const conflict=msg(c,'B',LID);conflict.addressMappings=[{role:'chat',lid:LID,pn:'15550009999@s.whatsapp.net',source:'evolution.remoteJidAlt'}];
    expect(await persist(conflict)).toMatchObject({outcome:'held',reconciliationReasons:['address_mapping_conflict']});
    expect(await persist(msg(c,'C',LID))).toMatchObject({outcome:'held',allowOperationalEffects:false,reconciliationReasons:['address_mapping_conflict']});
    expect(await db.message.count({where:{workspaceId:c.workspaceId}})).toBe(1);
  });
  it('normalizes Brazil PN forms and c.us without turning LID into a phone', async () => {
    const c=await context();const a=await persist(msg(c,'A','5511991234567@c.us'));
    const b=await persist(msg(c,'A','551191234567@s.whatsapp.net'));
    expect(b.messageId).toBe(a.messageId);
    await persist(msg(c,'B','5511991234567@lid'));
    expect((await db.contact.findMany({where:{workspaceId:c.workspaceId},orderBy:{phone:'asc'}})).map(r=>r.phone)).toEqual(['551191234567','5511991234567@lid']);
  });
  it('does not adopt official Meta through an unproven Evolution bridge', async () => {
    const a=await context();const channel=await db.channel.create({data:{workspaceId:a.workspaceId,provider:'meta_cloud',providerKey:randomUUID()}});
    const c:TrustedMessagingContext={...a,channelId:channel.id,channelProvider:'meta',provider:'evolution',connectionId:null};
    await db.integrationConfig.create({data:{workspaceId:a.workspaceId,provider:'meta_cloud',mode:'real',status:'connected',settings:{enabled:true,connectionMode:'evolution_official',evolutionInstanceName:c.sessionName,evolutionBaseUrl:'https://evolution.invalid',evolutionApiKey:'synthetic-key'}}});
    const contact=await db.contact.create({data:{workspaceId:c.workspaceId,phone:'15550001111'}});
    const conv=await db.conversation.create({data:{workspaceId:c.workspaceId,channelId:c.channelId,contactId:contact.id}});
    const message=await db.message.create({data:{workspaceId:c.workspaceId,conversationId:conv.id,direction:'inbound',type:'text',providerMessageId:'wamid.A',providerEventId:'meta:phone-id:wamid.A'}});
    const e=msg(c,'wamid.A');e.key.identityFormat='provider_native';e.key.rawId=null;
    expect(await persist(e,'bridge',{adoption:{messageId:message.id,key:e.key,source:'provider_exact_lookup'}})).toMatchObject({outcome:'held',reconciliationReasons:['meta_bridge_correlation_required']});
  });

  it('serializes concurrent PN/LID mirrors with proof and preserves source media per connection', async () => {
    const a=await context(), b=await context(a.workspaceId,a.channelId,'waha');
    const x=msg(a,'A',LID), y=msg(b);y.addressMappings=[{role:'chat',lid:LID,pn:PN,source:'waha.lid_lookup'}];
    x.content.type='audio';y.content.type='audio';
    x.media={kind:'audio',hasMedia:true,url:'https://evolution.test/a',state:'available'};
    y.media={kind:'audio',hasMedia:true,url:'https://waha.test/a',state:'available'};
    const results=await Promise.all([persist(x),persist(y)]);
    expect(results.filter(r=>r.outcome==='created')).toHaveLength(1);
    expect(new Set(results.map(r=>r.messageId)).size).toBe(1);
    const observations=await db.canonicalObservation.findMany({where:{workspaceId:a.workspaceId}});
    expect(observations.map(r=>(r.payload as any).media.url).sort()).toEqual(['https://evolution.test/a','https://waha.test/a']);
    expect(JSON.stringify(results)).not.toContain('https://');
  });
  it('rejects cross-channel connections and message origins inside the same tenant in SQL', async () => {
    const a=await context(), b=await context(a.workspaceId);const x=await persist(msg(a)), y=await persist(msg(b));
    await expect(db.canonicalObservation.update({where:{id:x.observationId},data:{connectionId:b.connectionId}})).rejects.toMatchObject({code:'P2003'});
    await expect(db.canonicalMessageIdentity.update({where:{id:x.identityId!},data:{conversationId:y.conversationId!}})).rejects.toMatchObject({code:'P2003'});
    const alias=await db.canonicalNativeAlias.findFirstOrThrow({where:{workspaceId:a.workspaceId,channelId:a.channelId}});
    await expect(db.canonicalNativeAlias.update({where:{id:alias.id},data:{identityId:y.identityId}})).rejects.toMatchObject({code:'P2003'});
    const identity=await db.canonicalMessageIdentity.findUniqueOrThrow({where:{id:x.identityId!}});
    const unbound = await db.message.create({data:{workspaceId:b.workspaceId,conversationId:y.conversationId!,direction:'inbound',type:'text'}});
    await expect(db.canonicalMessageIdentity.update({where:{id:identity.id},data:{messageId:unbound.id}})).rejects.toMatchObject({code:'P2003'});
  });

  it.each(['missing_native','cross_provider_native'] as const)('holds insufficient legacy adoption evidence: %s', async variant => {
    const c=await context(), event=msg(c);
    const contact=await db.contact.create({data:{workspaceId:c.workspaceId,phone:'15550001111'}});
    const conv=await db.conversation.create({data:{workspaceId:c.workspaceId,channelId:c.channelId,contactId:contact.id}});
    if(variant==='cross_provider_native') {
      event.context=await context(c.workspaceId,c.channelId,'waha');
      event.key.identityFormat='provider_native';event.key.rawId=null;event.key.nativeId='wamid.A';
    }
    const legacy=await db.message.create({data:{workspaceId:c.workspaceId,conversationId:conv.id,direction:'inbound',type:'text',providerMessageId:variant==='missing_native'?null:'wamid.A'}});
    const result=await persist(event,'adoption',{adoption:{messageId:legacy.id,key:event.key,source:'provider_exact_lookup'}});
    expect(result).toMatchObject({outcome:'held',allowOperationalEffects:false});
    expect(result.reconciliationReasons).toContain(variant==='missing_native'?'legacy_native_identity_missing':'provider_native_correlation_required');
    expect(await db.canonicalMessageIdentity.count({where:{workspaceId:c.workspaceId}})).toBe(0);
  });

  it('preserves legacy inbound delivered and outbound sent initial status', async () => {
    const c=await context(), outbound=msg(c,'OUT');outbound.key.direction='outbound';
    const inbound=await persist(msg(c)), sent=await persist(outbound);
    expect(await db.message.findUnique({where:{id:inbound.messageId!}})).toMatchObject({status:'delivered'});
    expect(await db.message.findUnique({where:{id:sent.messageId!}})).toMatchObject({status:'sent'});
  });
  it('deduplicates a provider event ID across receive-time, lifecycle and mode provenance changes', async () => {
    const c=await context(), first=msg({...c,mode:'history'});first.providerEventId='provider-id';
    const created=await persist(first);
    await db.channelConnection.update({where:{id:c.connectionId},data:{lifecycleGeneration:2}});
    const retry=msg({...c,observedAt:'2026-10-01T00:00:00Z',lifecycleGeneration:2});retry.providerEventId='provider-id';
    expect(await persist(retry)).toMatchObject({outcome:'duplicate',observationId:created.observationId,messageId:created.messageId,allowOperationalEffects:false});
    expect(await db.canonicalObservation.findUnique({where:{id:created.observationId}})).toMatchObject({mode:'history',lifecycleGeneration:0,receivedAt:new Date(c.observedAt)});
  });

  it('does not collapse known distinct stanza IDs when native serialization is absent', async () => {
    const c=await context(), a=msg(c,'A'), b=msg(c,'B');a.key.nativeId=null;b.key.nativeId=null;
    expect((await persist(a)).outcome).toBe('created');
    expect((await persist(b)).outcome).toBe('created');
  });
  it('persists revision reconciliation as a held observation for the future reducer', async () => {
    const c=await context();await persist(msg(c));const mirror=msg(c);mirror.currentRevision=msg(c,'EDIT').key;
    const result=await persist(mirror);
    expect(await db.canonicalObservation.findUnique({where:{id:result.observationId}})).toMatchObject({state:'held',reason:'revision_reconciliation_required',identityId:result.identityId});
  });
  it('rejects stale-snapshot transaction modes instead of pretending the advisory lock refreshes them', async () => {
    const c=await context();
    await expect(db.$transaction(tx=>store.persistInTransaction(tx,msg(c),{receiptKey:'snapshot'}),{isolationLevel:'RepeatableRead'})).rejects.toThrow('READ COMMITTED');
  });

  it.each([
    { name: 'different persisted sender', metadataSender: PN, aliasSender: null, eventSender: '15550002222@s.whatsapp.net', proof: 'none', accepted: false },
    { name: 'PN/LID without proof', metadataSender: LID, aliasSender: null, eventSender: PN, proof: 'none', accepted: false },
    { name: 'PN/LID proved in this observation', metadataSender: LID, aliasSender: null, eventSender: PN, proof: 'current', accepted: true },
    { name: 'PN/LID proved before this observation', metadataSender: LID, aliasSender: null, eventSender: PN, proof: 'previous', accepted: true },
    { name: 'stored c.us and observed s.whatsapp.net', metadataSender: '15550001111@c.us', aliasSender: null, eventSender: PN, proof: 'none', accepted: true },
    { name: 'stored s.whatsapp.net and observed c.us', metadataSender: PN, aliasSender: null, eventSender: '15550001111@c.us', proof: 'none', accepted: true },
    { name: 'conflicting alias with missing metadata', metadataSender: null, aliasSender: PN, eventSender: '15550002222@s.whatsapp.net', proof: 'none', accepted: false },
    { name: 'conflicting alias after metadata changed to the new sender', metadataSender: '15550002222@s.whatsapp.net', aliasSender: PN, eventSender: '15550002222@s.whatsapp.net', proof: 'none', accepted: false },
    { name: 'conflicting metadata despite an alias matching the new sender', metadataSender: PN, aliasSender: '15550002222@s.whatsapp.net', eventSender: '15550002222@s.whatsapp.net', proof: 'none', accepted: false },
    { name: 'matching alias with missing metadata', metadataSender: null, aliasSender: '15550001111@c.us', eventSender: PN, proof: 'none', accepted: true },
    { name: 'alias PN/LID without proof', metadataSender: null, aliasSender: LID, eventSender: PN, proof: 'none', accepted: false },
    { name: 'alias PN/LID with explicit proof', metadataSender: null, aliasSender: LID, eventSender: PN, proof: 'current', accepted: true },
    { name: 'exact recovery when both historical senders are unknown', metadataSender: null, aliasSender: null, eventSender: PN, proof: 'none', accepted: true }
  ])('checks all persisted group sender evidence before adopting: $name', async scenario => {
    const c = await context();
    const contact = await db.contact.create({data:{workspaceId:c.workspaceId,phone:GROUP,isGroup:true}});
    const conversation = await db.conversation.create({data:{workspaceId:c.workspaceId,channelId:c.channelId,contactId:contact.id,unreadCount:7,aiControlStatus:'human_controlled'}});
    const original = await db.message.create({data:{workspaceId:c.workspaceId,conversationId:conversation.id,direction:'inbound',type:'audio',body:'prepared legacy transcript',mediaUrl:'https://owned.test/legacy',providerMessageId:'A',metadata:{keep:'unchanged',transcription:{status:'completed'},...(scenario.metadataSender ? {groupSender:{jid:scenario.metadataSender,name:'Legacy'}} : {})}}});
    const legacyAlias = scenario.aliasSender ? await db.canonicalNativeAlias.create({data:{workspaceId:c.workspaceId,channelId:c.channelId,channelProvider:'evolution',provider:'evolution',tupleHash:'abcd',fullTuple:{origin:'legacy',messageId:original.id,conversationId:conversation.id,nativeId:'A',direction:'inbound',contactAddress:GROUP,groupSender:{jid:scenario.aliasSender,name:'Original sender'}}}}) : null;
    const mapping = {role:'sender' as const,lid:LID,pn:PN,source:'evolution.participantAlt' as const};
    if (scenario.proof === 'previous') {
      const proof = msg(c,'PROOF',GROUP,LID); proof.addressMappings=[mapping]; await persist(proof);
    }
    const event = msg(c,'A',GROUP,scenario.eventSender);
    if (scenario.proof === 'current') event.addressMappings=[mapping];
    const result = await persist(event,'adopt-group',{adoption:{messageId:original.id,key:event.key,source:'provider_exact_lookup'}});
    expect(result).toMatchObject({outcome:scenario.accepted?'enriched':'held',allowOperationalEffects:false});
    expect(await db.message.findUnique({where:{id:original.id}})).toEqual(original);
    expect(await db.conversation.findUnique({where:{id:conversation.id}})).toEqual(conversation);
    expect(await db.contact.count({where:{workspaceId:c.workspaceId}})).toBe(1);
    if (scenario.accepted) {
      expect(result.messageId).toBe(original.id);
      expect(await db.canonicalMessageIdentity.findUnique({where:{messageId:original.id}})).toMatchObject({id:result.identityId,messageId:original.id});
      if (legacyAlias) expect(await db.canonicalNativeAlias.findUnique({where:{id:legacyAlias.id}})).toMatchObject({state:'resolved',identityId:result.identityId,fullTuple:legacyAlias.fullTuple});
    } else {
      expect(result.reconciliationReasons).toContain('legacy_sender_identity_conflict');
      expect(result.identityId).toBeNull();
      expect(await db.canonicalMessageIdentity.findUnique({where:{messageId:original.id}})).toBeNull();
      expect(await db.canonicalObservation.findUnique({where:{id:result.observationId}})).toMatchObject({state:'held',reason:'legacy_sender_identity_conflict',identityId:null});
      expect(await db.canonicalNativeAlias.count({where:{workspaceId:c.workspaceId,identityId:{not:null}}})).toBe(0);
      if (legacyAlias) expect(await db.canonicalNativeAlias.findUnique({where:{id:legacyAlias.id}})).toEqual(legacyAlias);
    }
  });

});
