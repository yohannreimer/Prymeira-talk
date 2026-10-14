import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSessionState, useTalkSession } from '../../app/session/TalkSessionProvider';
import type { MessageDto } from '@prymeira-talk/shared';

type Metrics = { header: number[]; history: number[]; returns: number[]; hits: number; misses: number; canceled: number; longTasks: number; resources: number; transferred: number };
const EMPTY_METRICS: Metrics = { header: [], history: [], returns: [], hits: 0, misses: 0, canceled: 0, longTasks: 0, resources: 0, transferred: 0 };
const enabled = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('talkPerf') === '1';
const append = (rows: number[], value: number) => [...rows, Math.max(0, value)].slice(-100);
export const performanceP95 = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : 0;
const ms = (value: number | undefined) => `${(value ?? 0).toFixed(1)} ms`;

/** Opt-in, numeric-only, session-memory diagnostics. No resource URLs, content,
 * conversation identifiers, credentials, analytics calls or persistent storage. */
export function useTalkPerformance(selectedId: string | null, headerId: string | null, messages: MessageDto[] | undefined) {
  const { session } = useTalkSession();
  const [, setMetrics] = useSessionState('performance', EMPTY_METRICS);
  const pending = useRef<{ target: string; start: number; seq: number; headerDone: boolean; historyDone: boolean } | null>(null);
  const sequence = useRef(0);
  const [sequenceRender, setSequenceRender] = useState(0);
  const begin = useCallback((target: string, hit: boolean) => {
    if (!enabled()) return;
    const previous = pending.current;
    setMetrics(current => ({ ...current, hits: current.hits + Number(hit), misses: current.misses + Number(!hit),
      canceled: current.canceled + Number(Boolean(previous && !previous.historyDone)) }));
    pending.current = { target, start: performance.now(), seq: ++sequence.current, headerDone: false, historyDone: false };
    setSequenceRender(sequence.current);
  }, [setMetrics]);
  useLayoutEffect(() => {
    if (!enabled()) return;
    const item = pending.current;
    if (!item || selectedId !== item.target) return;
    const headerReady = headerId === item.target;
    const historyReady = headerReady && messages !== undefined && messages.every(message => message.conversationId === item.target);
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      if (pending.current?.seq !== item.seq || selectedId !== item.target) return;
      const elapsed = performance.now() - item.start;
      const recordHeader = headerReady && !item.headerDone;
      const recordHistory = historyReady && !item.historyDone;
      if (recordHeader) item.headerDone = true;
      if (recordHistory) item.historyDone = true;
      if (recordHeader || recordHistory) setMetrics(current => ({ ...current,
        header: recordHeader ? append(current.header, elapsed) : current.header,
        history: recordHistory ? append(current.history, elapsed) : current.history }));
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [selectedId, headerId, messages, setMetrics, sequenceRender]);
  useEffect(() => {
    if (!enabled() || !messages || selectedId !== headerId) return;
    const start = session.readUI<number | null>('performance:returnStart', null);
    if (start === null) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      if (session.readUI('performance:returnStart', null) !== start) return;
      session.writeUI('performance:returnStart', null, null);
      setMetrics(current => ({ ...current, returns: append(current.returns, performance.now() - start) }));
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [session, selectedId, headerId, messages, setMetrics]);
  return begin;
}

export function TalkPerformancePanel() {
  const { session } = useTalkSession();
  const [metrics, setMetrics] = useSessionState('performance', EMPTY_METRICS);
  useEffect(() => {
    if (!enabled() || typeof PerformanceObserver === 'undefined') return;
    const observers: PerformanceObserver[] = [];
    const observe = (type: string, update: (entries: PerformanceEntry[], current: Metrics) => Metrics) => {
      try {
        const observer = new PerformanceObserver(list => {
          const previous = session.readUI(`performance:last:${type}`, -1);
          const entries = list.getEntries().filter(entry => entry.startTime > previous);
          if (!entries.length) return;
          session.writeUI(`performance:last:${type}`, Math.max(...entries.map(entry => entry.startTime)), -1);
          setMetrics(current => update(entries, current));
        });
        observer.observe({ type, buffered: true }); observers.push(observer);
      } catch { /* Browser support varies; interaction metrics still work. */ }
    };
    observe('longtask', (entries, current) => ({ ...current, longTasks: current.longTasks + entries.length }));
    observe('resource', (entries, current) => ({ ...current, resources: current.resources + entries.length,
      transferred: current.transferred + entries.reduce((bytes, entry) => bytes + ((entry as PerformanceResourceTiming).transferSize || 0), 0) }));
    return () => observers.forEach(observer => observer.disconnect());
  }, [setMetrics, session]);
  if (!enabled()) return null;
  return <aside aria-label="Diagnóstico de desempenho" style={{ position: 'fixed', bottom: 12, left: 72, zIndex: 1000, padding: '10px 14px', borderRadius: 10, background: '#0f1511', color: '#e8f0eb', border: '1px solid #34d399', fontSize: 12, lineHeight: 1.6 }}>
    <strong>Desempenho · {metrics.history.length} aberturas</strong>
    <div>Cabeçalho p95: {ms(performanceP95(metrics.header))} · último: {ms(metrics.header.at(-1))}</div>
    <div>Histórico p95: {ms(performanceP95(metrics.history))} · último: {ms(metrics.history.at(-1))}</div>
    <div>Cache: {metrics.hits} acertos · {metrics.misses} ausências · {metrics.canceled} canceladas</div>
    <div>Retorno p95: {ms(performanceP95(metrics.returns))} · {metrics.returns.length} retornos</div>
    <div>Recursos: {metrics.resources} · {(metrics.transferred / 1024).toFixed(0)} KiB · tarefas longas: {metrics.longTasks}</div>
    <button type="button" onClick={() => setMetrics({ ...EMPTY_METRICS })}>Zerar diagnóstico</button>
  </aside>;
}
