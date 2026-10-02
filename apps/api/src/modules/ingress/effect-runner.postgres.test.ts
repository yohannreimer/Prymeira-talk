import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEffectRunner, effectBackoffMs, type EffectHandler } from './effect-runner.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;

describe('effectBackoffMs', () => {
  it('doubles per attempt up to the cap', () => {
    expect([1, 2, 3, 4, 10].map(n => effectBackoffMs(n, 1_000, 8_000))).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
  });
});

describe.skipIf(!databaseUrl)('effect runner on PostgreSQL', () => {
  let db: PrismaClient;
  const created: string[] = [];
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  afterAll(async () => {
    if (!db) return;
    await db.$executeRaw`DELETE FROM ingress_effects WHERE workspace_id = ANY(${created}::text[])`;
    await db.$disconnect();
  });

  /** Foreign keys are bypassed on purpose: this suite proves the lifecycle SQL only. The real
   * receipt -> progress -> effect chain is exercised by the stage 1B application tests. */
  async function seed(workspaceId: string, effects: Array<{ kind: string; messageId?: string | null; dependsOn?: string[]; state?: string; createdAt?: Date }>) {
    created.push(workspaceId);
    const ids: string[] = [];
    await db.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      for (const [index, effect] of effects.entries()) {
        const id = randomUUID(); ids.push(id);
        await tx.$executeRaw`INSERT INTO ingress_effects (id, workspace_id, channel_id, receipt_id, event_index, conversation_id, message_id, kind, logical_key, cause, frozen, state, created_at)
          VALUES (${id}::uuid, ${workspaceId}, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 0, ${effect.messageId ? randomUUID() : null}::uuid, ${effect.messageId ?? null}::uuid, ${effect.kind}, ${`k-${index}-${id}`},
            '{}'::jsonb, ${JSON.stringify({ dependsOn: effect.dependsOn ?? [] })}::jsonb, ${effect.state ?? 'pending'},
            ${effect.createdAt ?? new Date(Date.now() - 60_000 + index)})`;
      }
    });
    return ids;
  }
  const stateOf = (id: string) => db.ingressEffect.findUniqueOrThrow({ where: { id } });

  it('runs each effect exactly once with two competing workers', async () => {
    const ws = `runner-${randomUUID()}`;
    const ids = await seed(ws, Array.from({ length: 24 }, () => ({ kind: 'test.once' })));
    const seen: string[] = [];
    const handler: EffectHandler = async effect => { seen.push(effect.id); await new Promise(r => setTimeout(r, 5)); return { status: 'done', result: { by: 'x' } }; };
    const runners = ['a', 'b'].map(workerId => createEffectRunner({ db, workerId, handlers: { 'test.once': handler } }));
    await Promise.all(runners.map(runner => runner.drain()));
    const mine = seen.filter(id => ids.includes(id));
    expect(mine).toHaveLength(24);
    expect(new Set(mine).size).toBe(24);
    const rows = await db.ingressEffect.findMany({ where: { workspaceId: ws } });
    expect(rows.every(row => row.state === 'done' && row.completedAt && row.attempts === 1 && row.lockedBy === null && row.leaseUntil === null)).toBe(true);
  });

  it('holds a dependent effect until its dependency is terminal, and never blocks on a missing one', async () => {
    const ws = `runner-${randomUUID()}`;
    const messageId = randomUUID();
    const [media, agent, orphan] = await seed(ws, [
      { kind: 'test.media', messageId },
      { kind: 'test.agent', messageId, dependsOn: ['test.media'] },
      { kind: 'test.agent', messageId: randomUUID(), dependsOn: ['test.media'] }
    ]);
    const order: string[] = [];
    const handlers: Record<string, EffectHandler> = {
      'test.media': async effect => { order.push(`media:${effect.id === media}`); return { status: 'failed', errorCode: 'PROVIDER_DOWN' }; },
      'test.agent': async effect => { order.push(`agent:${effect.id}`); return { status: 'done' }; }
    };
    const runner = createEffectRunner({ db, workerId: 'w', handlers: { 'test.agent': handlers['test.agent']! } });
    await runner.drain();
    expect(order).toEqual([`agent:${orphan}`]);
    expect((await stateOf(agent!)).state).toBe('pending');
    const both = createEffectRunner({ db, workerId: 'w', handlers });
    await both.drain();
    expect(order.slice(1)).toEqual(['media:true', `agent:${agent}`]);
    expect(await stateOf(media!)).toMatchObject({ state: 'failed', lastErrorCode: 'PROVIDER_DOWN' });
    expect((await stateOf(agent!)).state).toBe('done');
  });

  it('retries with backoff, fails after the attempt budget, and can be requeued without a duplicate', async () => {
    const ws = `runner-${randomUUID()}`;
    const [id] = await seed(ws, [{ kind: 'test.flaky' }]);
    let clock = new Date(Date.now() + 5_000);
    let calls = 0;
    const runner = createEffectRunner({ db, workerId: 'w', maxAttempts: 3, baseBackoffMs: 1_000, now: () => clock,
      handlers: { 'test.flaky': async () => { calls += 1; return { status: 'retry', errorCode: 'TIMEOUT' }; } } });
    expect(await runner.runOnce()).toBe(true);
    expect(await stateOf(id!)).toMatchObject({ state: 'pending', attempts: 1, lastErrorCode: 'TIMEOUT' });
    expect(await runner.runOnce()).toBe(false);
    clock = new Date(clock.getTime() + 1_500);
    expect(await runner.runOnce()).toBe(true);
    clock = new Date(clock.getTime() + 2_500);
    expect(await runner.runOnce()).toBe(true);
    expect(await stateOf(id!)).toMatchObject({ state: 'failed', attempts: 3, lastErrorCode: 'TIMEOUT' });
    expect(calls).toBe(3);
    expect(await runner.runOnce()).toBe(false);
    expect(await runner.requeue(id!)).toBe(true);
    expect(await runner.requeue(id!)).toBe(false);
    expect(await stateOf(id!)).toMatchObject({ state: 'pending', attempts: 0, completedAt: null });
  });

  it('recovers an expired lease and discards the late result of the previous holder', async () => {
    const ws = `runner-${randomUUID()}`;
    const [id] = await seed(ws, [{ kind: 'test.slow' }]);
    let clock = new Date(Date.now() + 5_000);
    const handlers = { 'test.slow': async () => ({ status: 'done' as const }) };
    const first = createEffectRunner({ db, workerId: 'first', leaseMs: 10_000, now: () => clock, handlers });
    const second = createEffectRunner({ db, workerId: 'second', leaseMs: 10_000, now: () => clock, handlers });
    const claimed = await first.claim();
    expect(claimed?.id).toBe(id);
    expect(await second.claim()).toBeNull();
    clock = new Date(clock.getTime() + 11_000);
    const reclaimed = await second.claim();
    expect(reclaimed).toMatchObject({ id, attempts: 2 });
    expect(await first.finish(claimed!, { status: 'done' })).toBe(0);
    expect((await stateOf(id!)).state).toBe('running');
    expect(await second.finish(reclaimed!, { status: 'done', result: { ok: true } })).toBe(1);
    expect(await stateOf(id!)).toMatchObject({ state: 'done', result: { ok: true } });
  });

  it('turns a throwing handler into a retry and ignores kinds it has no handler for', async () => {
    const ws = `runner-${randomUUID()}`;
    const [boom, other] = await seed(ws, [{ kind: 'test.boom' }, { kind: 'test.unhandled' }]);
    const runner = createEffectRunner({ db, workerId: 'w', baseBackoffMs: 60_000, handlers: { 'test.boom': async () => { throw new Error('x'); } } });
    await runner.drain();
    expect(await stateOf(boom!)).toMatchObject({ state: 'pending', lastErrorCode: 'HANDLER_THREW', attempts: 1 });
    expect(await stateOf(other!)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('keeps identity and frozen inputs immutable and a completed effect final', async () => {
    const ws = `runner-${randomUUID()}`;
    const [id] = await seed(ws, [{ kind: 'test.guard' }]);
    await expect(db.$executeRaw`UPDATE ingress_effects SET kind = 'other' WHERE id = ${id}::uuid`).rejects.toThrow(/immutable ingress fact/);
    await expect(db.$executeRaw`UPDATE ingress_effects SET frozen = '{}'::jsonb WHERE id = ${id}::uuid`).rejects.toThrow(/immutable ingress fact/);
    await createEffectRunner({ db, workerId: 'w', handlers: { 'test.guard': async () => ({ status: 'done' }) } }).drain();
    await expect(db.$executeRaw`UPDATE ingress_effects SET state = 'pending', completed_at = NULL WHERE id = ${id}::uuid`).rejects.toThrow(/final/);
  });

  it('rejects states and leases the schema must never allow', async () => {
    const ws = `runner-${randomUUID()}`;
    const [id] = await seed(ws, [{ kind: 'test.constraint' }]);
    await expect(db.$executeRaw`UPDATE ingress_effects SET state = 'running' WHERE id = ${id}::uuid`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE ingress_effects SET state = 'done' WHERE id = ${id}::uuid`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE ingress_effects SET state = 'weird' WHERE id = ${id}::uuid`).rejects.toThrow();
  });
});
