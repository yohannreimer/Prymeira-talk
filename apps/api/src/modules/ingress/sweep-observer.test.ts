import { expect, it, vi } from 'vitest';
import { createSweepObserver } from './sweep-observer.js';
it('isolates failed steps, logs only aggregate counts and bounds timing summaries', async () => {
  let clock = 400_000; const logger = { info: vi.fn(), warn: vi.fn() };
  const observer = createSweepObserver(logger as never, () => clock);
  await observer.run('recertification', 'recertification_sweep', async () => { clock += 20; throw Error('private-query-and-phone'); });
  expect(await observer.run('gaps', 'gap_recovery', async () => { clock += 5; return { recovered: 2, body: 'private-message' }; })).toMatchObject({ recovered: 2 });
  observer.flush(); observer.flush();
  expect(logger.info).toHaveBeenCalledTimes(1);
  expect(logger.info.mock.calls[0]![1]).toMatchObject({ recertification: { failures: 1, maxMs: 20 }, gaps: { counts: { recovered: 2 } } });
  expect(JSON.stringify(logger.info.mock.calls)).not.toContain('private');
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private');
});

it('does not lose the duration of a history import across an intermediate summary', async () => {
  let at = 400_000, finish!: () => void;
  const logger = { info: vi.fn(), warn: vi.fn() }, observer = createSweepObserver(logger as never, () => at);
  const history = observer.run('history', 'waha_history', async () => { await new Promise<void>(resolve => { finish = resolve; }); return { imported: 1 }; });
  observer.flush(); at += 400_000; finish(); await history; observer.flush();
  expect(logger.info.mock.calls.at(-1)![1]).toMatchObject({ history: { runs: 1, totalMs: 400_000, counts: { imported: 1 } } });
});
