import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { ContextualFollowupContext } from "../src/modules/followups/contextual-followup-context.js";
import { createScriptedModel } from "../src/modules/harness/core/model.js";
import type { RunnerDeps } from "../src/modules/harness/core/runner.js";
import { generateContextualFollowup } from "../src/modules/harness/agentes/followup/producao.js";
import type { FollowupAnalysis, MessageEvidence, PendingItem } from "../src/modules/harness/agentes/followup/tipos.js";
import { resolveFollowupStepInstruction } from "../src/modules/agents/followup-step-instruction.js";

// Fixture data only. This script imports no database, scheduler, queue, transport or Calendar module.
export type SyntheticFixture = { caseId: string; synthetic: true; now: string; profile: "attendance" | "commercial" | "prospecting";
  identity: { agentName: string; companyName: string }; messages: Array<{ id: string; direction: string; author: string; type: string; body: string; createdAt: string }>;
  expected: Record<string, any>; origin?: Record<string, any> | null; meeting?: Record<string, any>; cadence?: Record<string, number>;
  lifecycle?: Record<string, any>; knowledge?: Array<Record<string, any>>; channel?: Record<string, any>; failure?: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const forbiddenEffects = Object.freeze({ transport: () => { throw new Error("REPLAY_TRANSPORT_FORBIDDEN"); }, calendar: () => { throw new Error("REPLAY_CALENDAR_FORBIDDEN"); } });

export function replayContext(f: SyntheticFixture): ContextualFollowupContext {
  if (f.synthetic !== true || !["attendance", "commercial", "prospecting"].includes(f.profile)) throw new Error("Synthetic fixtures only");
  const messages: ContextualFollowupContext["messages"] = f.messages.map(m => ({ id: m.id, direction: m.direction, type: m.type,
    label: m.author === "customer" ? "cliente" : m.author === "system" ? "sistema" : "atendente", body: m.body, createdAt: m.createdAt }));
  const form = f.origin?.source === "automation_webhook" && f.origin.verified === true;
  if (form) messages.unshift({ id: "synthetic_form_submission", direction: null, type: "system", label: "sistema", body: "Solicitação comprovada pelo site: melhorar atendimento", createdAt: f.origin!.submittedAt });
  const factualSources = (f.knowledge ?? []).filter(s => s.approvalStatus === "confirmed").map(s => ({ id: String(s.id), title: "Synthetic approved fact", content: String(s.content), fileUrl: null }));
  const behavioralSources = (f.knowledge ?? []).filter(s => s.approvalStatus === "behavioral").map(s => ({ id: String(s.id), title: "Synthetic behavior", content: String(s.content), fileUrl: null }));
  const recordedBookings = f.meeting?.status === "confirmed" ? [{ evidenceId: "synthetic_booking", eventId: String(f.meeting.eventId), startsAt: String(f.meeting.startsAt) }] : [];
  return {
    workspaceId: "synthetic_workspace", conversationId: "synthetic_conversation", agentId: "synthetic_agent", sessionId: "synthetic_session", anchorMessageId: messages.at(-1)!.id, now: f.now,
    instructions: { agentRules: `Você representa somente ${f.identity.companyName}. Identidade: ${f.identity.agentName}. Retome a pendência existente. Não invente fatos ou execute ações externas.`, stepInstruction: "Retome a pendência real conforme este perfil.", behavioralSources },
    factualSources, messages,
    profile: { profile: f.profile, identity: { agentId: "synthetic_agent", agentName: f.identity.agentName }, origin: form ? "site_form" : "direct_inbound", formEvidenceMessageIds: form ? ["synthetic_form_submission"] : [], factualSourceIds: factualSources.map(s => s.id),
      meeting: { state: recordedBookings.length ? "recorded_booking" : "unknown", recordedBookings, currentCalendarVerified: false, availability: "unknown" },
      prospecting: f.profile === "prospecting" ? { goal: "Conversar sobre o atendimento com este respondente", campaignId: "synthetic_campaign", recipientId: "synthetic_recipient", generation: "synthetic_generation", sessionId: "synthetic_session" } : null,
      constraints: ["Regras comportamentais não comprovam fatos comerciais.", "Sem Calendar, envio de arquivo, terceiros ou novas condições comerciais."], abstentions: ["availability_unknown"] },
    sentAttempts: Array.from({ length: f.cadence?.confirmedSent ?? 0 }, (_, i) => ({ followupId: `synthetic_sent_${i}`, sentAt: f.now })),
    coverage: { complete: true, anchorIncluded: true, messageIds: messages.map(m => m.id), factualSourceIds: factualSources.map(s => s.id), behavioralSourceIds: behavioralSources.map(s => s.id), domainEvidenceIds: recordedBookings.map(b => b.evidenceId), sentAttemptIds: [], serializedCharacters: 0, budget: { maxCharacters: 180000, maxMessages: 2000, maxSources: 100 } }
  };
}

/** Scripted observations are derived from the synthetic conversation, never its expected result.
 * They qualify evidence handling/control flow; separate live-model runs qualify model behavior. */
export function scriptedObservations(context: ContextualFollowupContext): FollowupAnalysis {
  const proof = (m: typeof context.messages[number]): MessageEvidence => ({ messageId: m.id, author: m.label, excerpt: m.body! });
  const customers = context.messages.filter(m => m.label === "cliente"), agents = context.messages.filter(m => m.label === "atendente");
  const engagement = customers[0] ?? context.messages.find(m => context.profile.formEvidenceMessageIds.includes(m.id));
  const supplier = customers.find(m => /sou fornecedor/i.test(m.body ?? ""));
  const refused = customers.find(m => /não tenho interesse|não me envie/i.test(m.body ?? ""));
  const closed = customers.find(m => /era só isso|pedido anterior recebido/i.test(m.body ?? ""));
  const future = customers.find(m => /23 de outubro/i.test(m.body ?? ""));
  const analysis: FollowupAnalysis = { contact: { role: supplier ? "supplier" : engagement ? "customer" : "unknown", evidence: supplier ? proof(supplier) : engagement ? proof(engagement) : null },
    closure: refused ? { kind: "refusal", evidence: proof(refused) } : closed ? { kind: "closed", evidence: proof(closed) } : null,
    customerTiming: future ? { notBefore: "2026-10-23T17:00:00.000Z", evidence: proof(future) } : null, pendingItems: [], resolutions: [] };
  if (!engagement || supplier || context.profile.meeting.recordedBookings.length) return analysis;
  const lastAgent = agents.at(-1), lastCustomer = customers.at(-1);
  let source = lastAgent, owner: PendingItem["owner"] = "customer", kind: PendingItem["kind"] = "other", subject = "Retomar atendimento";
  if (lastCustomer && /pessoa responsável/i.test(lastCustomer.body ?? "")) { source = lastCustomer; owner = "company"; kind = "referral"; subject = "Responsável de compras indicado pelo contato"; }
  else if (lastAgent && /preparar.*orçamento/i.test(lastAgent.body ?? "")) { owner = "company"; kind = "quote"; subject = "Preparar o orçamento solicitado"; }
  else if (lastAgent && /verificar a agenda/i.test(lastAgent.body ?? "")) { owner = "company"; kind = "answer"; subject = "Confirmar internamente a reserva solicitada"; }
  else if (lastAgent && /espessura/i.test(lastAgent.body ?? "")) { kind = "technical_detail"; subject = "Espessura das chapas solicitadas"; }
  else if (lastAgent && /segue.*catálogo/i.test(lastAgent.body ?? "")) { kind = "quote_evaluation"; subject = "Avaliação do catálogo solicitado e entregue"; }
  else if (lastAgent && /segue.*orçamento/i.test(lastAgent.body ?? "")) { kind = "quote_evaluation"; subject = "Avaliação do orçamento entregue"; if (lastCustomer && /avaliar/i.test(lastCustomer.body ?? "")) source = lastCustomer; }
  else if (lastAgent && /prefere|quer conversar/i.test(lastAgent.body ?? "")) { kind = "time_choice"; subject = "Escolha de horário para conversar"; }
  else if (future) { source = future; subject = "Retomar somente na data pedida"; }
  else return analysis;
  if (source) analysis.pendingItems.push({ id: "synthetic_pending", owner, kind, subject, evidence: proof(source), engagement: proof(engagement), factualEvidence: [] });
  return analysis;
}

function scriptedText(analysis: FollowupAnalysis) {
  const p = analysis.pendingItems.at(-1);
  return p?.kind === "time_choice" ? "Conseguiu escolher um horário para conversarmos?"
    : p?.kind === "technical_detail" ? "Qual espessura você precisa para as chapas?"
    : p?.kind === "quote_evaluation" ? /catálogo/i.test(p.subject) ? "Conseguiu avaliar o catálogo que pediu?" : "Conseguiu avaliar o orçamento que recebeu?"
    : "Quer retomar a conversa sobre o atendimento?";
}

export async function replayFixture(f: SyntheticFixture, liveDeps?: RunnerDeps) {
  const started = performance.now(), context = replayContext(f), life = f.lifecycle ?? {};
  const baselineInstruction = resolveFollowupStepInstruction({ kind: "qualification", configuredInstruction: context.instructions.stepInstruction });
  const baseline = { engine: "legacy_qualification_instruction", scope: "instruction_contract_only", instructionHash: hash(baselineInstruction), technicalRestriction: baselineInstruction.includes("qualificação técnica"), modelQualityEvaluated: false };
  const blocked = life.claimWinner === false || life.deliveryStatus === "uncertain" || (life.aiControlStatus && life.aiControlStatus !== "agent_allowed")
    || (life.sessionId && life.sessionId !== life.expectedSessionId) || (life.generation && life.generation !== life.expectedGeneration)
    || (life.expectedUpdatedAt && life.expectedUpdatedAt !== life.actualUpdatedAt);
  let result: Awaited<ReturnType<typeof generateContextualFollowup>>;
  let reasonCode: string | null = null;
  if (blocked) { result = { decision: { type: "unavailable", reason: "policy_changed" }, reviewApproved: false }; reasonCode = "fixture_lifecycle_guard"; }
  else if (f.failure === "context_limit") result = { decision: { type: "unavailable", reason: "context_limit" }, reviewApproved: false };
  else {
    const analysis = scriptedObservations(context);
    const deps: RunnerDeps = liveDeps ?? {
      analista: createScriptedModel("synthetic-analyst", (_request, i) => {
        if (f.failure === "analysis_failed") throw new Error("Synthetic provider unavailable");
        return { content: null, toolCalls: i === 0 ? [{ id: "analysis", name: "registrar_analise_followup", arguments: JSON.stringify(analysis) }] : [] };
      }),
      model: createScriptedModel("synthetic-writer", () => ({ content: null, toolCalls: [{ id: "draft", name: "responder", arguments: JSON.stringify({ texto: f.failure === "empty_message" ? "" : scriptedText(analysis) }) }] })),
      ...(f.failure === "review_failed" ? {} : { judge: async () => ({ ok: true as const }) })
    };
    result = await generateContextualFollowup({ context, maxAttempts: f.cadence?.configuredSteps ?? 4, deps, hoursWithoutResponse: 2 });
    if ((f.cadence?.confirmedSent ?? 0) >= (f.cadence?.configuredSteps ?? 4)) reasonCode = "followup_step_limit";
  }
  const output = result.decision, text = output.type === "customer_message" ? output.body : output.type === "seller_reminder" ? output.summary : "";
  const failures: string[] = [];
  if (f.expected.decision && output.type !== f.expected.decision) failures.push(`decision ${output.type} != ${f.expected.decision}`);
  if (f.expected.reason && (reasonCode ?? ("reason" in output ? output.reason : null)) !== f.expected.reason) failures.push(`reason mismatch: ${reasonCode ?? ("reason" in output ? output.reason : "none")}`);
  const topics: Record<string, RegExp> = { time_choice: /horário/i, catalog_evaluation: /catálogo/i, quote_evaluation: /orçamento/i, missing_thickness: /espessura/i, prepare_quote: /preparar.*orçamento/i, confirm_booking_internally: /confirmar.*reserva/i, buyer_referral: /responsável.*compras/i };
  if (f.expected.requiredTopic && !topics[f.expected.requiredTopic]?.test(text)) failures.push(`missing topic ${f.expected.requiredTopic}`);
  const forbidden: Record<string, RegExp> = { new_introduction: /me chamo|sou a |somos /i, quote_delivered: /orçamento.*(receb|avali|enviad)/i, price: /R\$|\bpreço\b/i,
    form_received: /formulário|pelo site/i, meeting_booked: /reserva confirmada|reunião marcada/i, new_availability: /disponível|temos vaga/i,
    book_another_meeting: /agendar|marcar.*reunião/i, "90%": /90\s*%/, guaranteed_result: /resultado garantido/i, approved_discount: /desconto.*aprovado/i,
    dimensions: /quais.*medidas/i, quantity: /qual.*quantidade/i, thickness: /qual.*espessura/i };
  for (const key of [...(f.expected.forbiddenClaims ?? []), ...(f.expected.forbiddenQuestions ?? [])]) if (forbidden[key]?.test(text)) failures.push(`forbidden ${key}`);
  if (output.type === "customer_message" && (!text.trim() || !result.reviewApproved)) failures.push("empty or unreviewed customer draft");
  return { caseId: f.caseId, profile: f.profile, engine: liveDeps ? "contextual_v1_live_models" : "contextual_v1_scripted", rulesHash: hash(context.instructions), sourcesHash: hash(context.factualSources),
    baseline, decision: output, reasonCode, evidenceMessageIds: "evidenceMessageIds" in output ? output.evidenceMessageIds : [], reviewApproved: result.reviewApproved,
    transportCalls: 0, calendarCalls: 0, automaticRetry: false, elapsedMs: Math.round(performance.now() - started), passed: failures.length === 0, failures };
}

export async function main() {
  const fixtures = (await readFile(new URL("./fixtures/contextual-followups-synthetic.jsonl", import.meta.url), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as SyntheticFixture);
  const results = [];
  for (const fixture of fixtures) results.push(await replayFixture(fixture));
  const destination = fileURLToPath(new URL("../../../validation-artifacts/contextual-followup-replay.json", import.meta.url));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify({ mode: "scripted_control_flow_not_model_quality", cases: results.length, failed: results.filter(r => !r.passed).length, results }, null, 2));
  console.log(JSON.stringify({ cases: results.length, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).map(r => ({ caseId: r.caseId, failures: r.failures })), report: destination }));
  if (results.some(r => !r.passed)) process.exitCode = 1;
}
if (process.argv[1]?.endsWith("replay-contextual-followups.ts")) void main().catch(error => { console.error(error instanceof Error ? error.message : "Replay failed"); process.exitCode = 1; });
