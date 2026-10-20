import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { createReceiptEffectBatch, RECEIPT_EFFECT_BATCH_LIMIT } from './effect-batch.js';
const receipt = { id: 'receipt', workspaceId: 'ws', channelId: 'channel', ordinal: 1n, source: {} };
function fixture() {
  const read = vi.fn(async () => ({ id: 2n, workspaceId: receipt.workspaceId, channelId: receipt.channelId }));
  const write = vi.fn(async (_args: unknown) => ({ count: 1 }));
  const tx = { ingressFrontier: { findUniqueOrThrow: read }, ingressEffect: { createMany: write } } as unknown as Prisma.TransactionClient;
  return { tx, read, write };
}
describe('event-owned effect batch', () => {
  it('empty mirrors do no SQL and a closed batch cannot be reused', async () => {
    const f = fixture(), batch = createReceiptEffectBatch(f.tx, receipt, 0);
    await batch.flush(); expect(f.read).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    expect(() => batch.add('kind', 'key', null, null, null, {})).toThrow('closed');
    await expect(batch.flush()).rejects.toThrow('closed');
  });
  it('captures the first frozen value and deduplicates keys without consuming the event bound', async () => {
    const f = fixture(), batch = createReceiptEffectBatch(f.tx, receipt, 0), frozen = { value: 1 };
    batch.add('kind', 'key', null, null, null, frozen); frozen.value = 2;
    for (let i = 0; i < 100; i++) batch.add('kind', 'key', null, null, null, { value: 3 });
    await batch.flush();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.write).toHaveBeenCalledWith({ skipDuplicates: true, data: [expect.objectContaining({ frozen: { value: 1 }, cause: expect.objectContaining({ frontierId: '2', receiptOrdinal: '1' }) })] });
  });
  it('rejects a frontier from another scope before any insert', async () => {
    const f = fixture(); f.read.mockResolvedValue({ id: 3n, workspaceId: 'foreign', channelId: 'channel' });
    const batch = createReceiptEffectBatch(f.tx, receipt, 0); batch.add('kind', 'key', null, null, null, {});
    await expect(batch.flush()).rejects.toThrow('scope mismatch'); expect(f.write).not.toHaveBeenCalled();
  });
  it('bounds unique obligations and propagates SQL failure without allowing reuse', async () => {
    const f = fixture(), batch = createReceiptEffectBatch(f.tx, receipt, 0);
    for (let i = 0; i < RECEIPT_EFFECT_BATCH_LIMIT; i++) batch.add('kind', String(i), null, null, null, {});
    expect(() => batch.add('kind', 'overflow', null, null, null, {})).toThrow('limit');
    await expect(batch.flush()).rejects.toThrow('closed'); expect(f.write).not.toHaveBeenCalled();
    const retry = createReceiptEffectBatch(f.tx, receipt, 0); retry.add('kind', 'new', null, null, null, {});
    f.write.mockRejectedValue(new Error('fixture database unavailable'));
    await expect(retry.flush()).rejects.toThrow('fixture database unavailable');
    await expect(retry.flush()).rejects.toThrow('closed');
  });
});
