import { randomUUID } from 'node:crypto';
import { automationFlowSchema, type AutomationFlowDefinition } from '@prymeira-talk/shared';
import type { ActionResult, AutomationRunRecord, AutomationRunnerPrisma } from './automation-runner.js';

type NodeExecution = { result: ActionResult; branch?: string; branchExact?: boolean; stop?: boolean };
type Step = { nodeId: string; state: 'started' | 'completed'; execution?: NodeExecution };
type Checkpoint = { version: 1; flow: AutomationFlowDefinition; steps: Step[] };
const LEASE_MS = 5 * 60_000;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export class AutomationExecutionError extends Error {
  constructor(readonly code: 'AUTOMATION_EXECUTION_BUSY' | 'AUTOMATION_EXECUTION_LOST' | 'AUTOMATION_EXECUTION_UNCERTAIN', message: string) {
    super(message); this.name = 'AutomationExecutionError';
  }
}

/** An event claim is committed before any external action. A completed node is
 * reused on recovery. A started node whose completion was lost is deliberately
 * not executed again: its external outcome requires review. */
export async function claimAutomationExecution(prisma: AutomationRunnerPrisma, input: {
  workspaceId: string; ruleId: string; eventKey: string; input: unknown; flow: AutomationFlowDefinition;
}) {
  const updateMany = prisma.automationRun.updateMany;
  if (!updateMany) throw new Error('Durable automation execution storage is unavailable.');
  const token = randomUUID(), id = randomUUID(), at = new Date();
  const fresh: Checkpoint = { version: 1, flow: input.flow, steps: [] };
  const where = { workspaceId_ruleId_eventKey: { workspaceId: input.workspaceId, ruleId: input.ruleId, eventKey: input.eventKey } };
  const row = await prisma.automationRun.upsert({ where,
    create: { id, workspaceId: input.workspaceId, ruleId: input.ruleId, eventKey: input.eventKey,
      status: 'running', input: input.input, result: { execution: fresh }, executionToken: token, leaseUntil: new Date(at.getTime() + LEASE_MS) },
    update: {} });
  if (['completed', 'failed', 'skipped'].includes(row.status)) return { claimed: false as const, run: row };
  const recorded = object(object(row.result).execution);
  const parsed = automationFlowSchema.safeParse(recorded.flow);
  const validSteps = Array.isArray(recorded.steps) && recorded.steps.every((value: unknown) => {
    const step = object(value), execution = object(step.execution), result = object(execution.result);
    return typeof step.nodeId === 'string' && parsed.success && parsed.data.nodes.some(node => node.id === step.nodeId) &&
      (step.state === 'started' || (step.state === 'completed' && result.nodeId === step.nodeId &&
        typeof result.type === 'string' && typeof result.label === 'string' && ['completed', 'failed', 'skipped'].includes(String(result.status)) &&
        (execution.branch === undefined || typeof execution.branch === 'string') &&
        (execution.branchExact === undefined || typeof execution.branchExact === 'boolean') &&
        (execution.stop === undefined || typeof execution.stop === 'boolean')));
  });
  const validCheckpoint = parsed.success && recorded.version === 1 && validSteps;
  const checkpoint: Checkpoint = row.executionToken === token ? fresh : validCheckpoint
    ? { version: 1, flow: parsed.data!, steps: recorded.steps as Step[] } : fresh;
  async function holdForReview(message: string): Promise<never> {
    const changed = await updateMany!.call(prisma.automationRun, { where: { workspaceId: input.workspaceId, id: row.id,
      status: 'running', executionToken: row.executionToken ?? null,
      ...(row.executionToken ? { leaseUntil: { lte: at } } : { updatedAt: row.updatedAt }) },
      data: { status: 'failed', executionToken: null, leaseUntil: null,
        result: { ...object(row.result), reviewRequired: true, error: message } } });
    if (changed.count !== 1) throw new AutomationExecutionError('AUTOMATION_EXECUTION_BUSY', 'Automation event changed concurrently.');
    throw new AutomationExecutionError('AUTOMATION_EXECUTION_UNCERTAIN', message);
  }
  const owned = row.executionToken === token;
  if (!owned) {
    const queued = row.status === 'queued' && !row.executionToken;
    const expired = row.status === 'running' && row.executionToken && row.leaseUntil && new Date(row.leaseUntil).getTime() <= at.getTime();
    if (!queued && !expired) {
      if (row.status === 'running' && !row.executionToken && new Date(row.updatedAt).getTime() <= at.getTime() - LEASE_MS) return holdForReview('Legacy automation has no durable action proof; human review is required.');
      throw new AutomationExecutionError('AUTOMATION_EXECUTION_BUSY', 'Automation event is already being processed.');
    }
    if (expired && !validCheckpoint) return holdForReview('Automation checkpoint is unavailable or invalid; automatic replay is disabled and human review is required.');
    const changed = await updateMany.call(prisma.automationRun, { where: { workspaceId: input.workspaceId, id: row.id,
      status: row.status, executionToken: row.executionToken ?? null,
      ...(expired ? { leaseUntil: { lte: at } } : {}) },
      data: { status: 'running', executionToken: token, leaseUntil: new Date(at.getTime() + LEASE_MS),
        result: { ...object(row.result), execution: checkpoint } } });
    if (changed.count !== 1) throw new AutomationExecutionError('AUTOMATION_EXECUTION_BUSY', 'Automation event was claimed concurrently.');
  }
  const run = { ...row, executionToken: token, status: 'running' };
  const fence = () => ({ workspaceId: input.workspaceId, id: row.id, status: 'running', executionToken: token, leaseUntil: { gt: new Date() } });
  async function save(data: Record<string, unknown>) {
    const changed = await updateMany!.call(prisma.automationRun, { where: fence(), data });
    if (changed.count !== 1) throw new AutomationExecutionError('AUTOMATION_EXECUTION_LOST', 'Automation execution lease was lost; automatic dispatch stopped.');
  }
  const heartbeat = setInterval(() => {
    void save({ leaseUntil: new Date(Date.now() + LEASE_MS) }).catch(() => undefined);
  }, LEASE_MS / 3);
  heartbeat.unref?.();
  async function step(position: number, nodeId: string, work: () => Promise<NodeExecution>): Promise<NodeExecution> {
    const previous = checkpoint.steps[position];
    if (previous) {
      if (previous.nodeId !== nodeId) throw new AutomationExecutionError('AUTOMATION_EXECUTION_UNCERTAIN', 'Automation graph differs from its durable checkpoint.');
      if (previous.state === 'completed' && previous.execution) return previous.execution;
      throw new AutomationExecutionError('AUTOMATION_EXECUTION_UNCERTAIN', 'An automation action started before a process interruption; its outcome requires review and will not be repeated.');
    }
    checkpoint.steps.push({ nodeId, state: 'started' });
    await save({ result: { ...object(row.result), execution: checkpoint } });
    const execution = await work();
    checkpoint.steps[position] = { nodeId, state: 'completed', execution };
    await save({ result: { ...object(row.result), execution: checkpoint } });
    return execution;
  }
  async function finish(status: string, result: unknown, recordedInput: unknown): Promise<AutomationRunRecord> {
    const finalResult = { ...object(result), execution: checkpoint };
    await save({ status, result: finalResult, input: recordedInput, executionToken: null, leaseUntil: null });
    return { ...run, status, result: finalResult, input: recordedInput, executionToken: null, leaseUntil: null, updatedAt: new Date() };
  }
  return { claimed: true as const, run, flow: checkpoint.flow, firstNodeId: checkpoint.steps[0]?.nodeId,
    step, finish, close() { clearInterval(heartbeat); } };
}

export type AutomationExecution = Extract<Awaited<ReturnType<typeof claimAutomationExecution>>, { claimed: true }>;
