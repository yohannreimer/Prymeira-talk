import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MAX_LEAD_WHATSAPP_BATCH_SIZE,
  MAX_LEAD_WHATSAPP_UNIQUE_NUMBERS,
  leadWhatsappVerificationRequestSchema
} from "@prymeira-talk/shared";
import type { CheckWhatsappNumbersAvailabilityResult, WhatsappNumberAvailability } from "../evolution/evolution.client.js";
import { EvolutionClientError } from "../evolution/evolution.client.js";
import { canonicalizePhone } from "../contacts/phone-normalization.js";
import { whatsappPhoneCandidates, type WhatsappPhoneCandidates } from "./lead-whatsapp-numbers.js";
import {
  LeadLeaseLostError,
  LeadsDomainError,
  type ClaimedLeadJob,
  type LeadsRepositoryLike
} from "./leads.repository.js";

const whatsappJobInputSchema = z.object({
  requestId: z.string().uuid(),
  instanceName: z.string().trim().min(1),
  numbers: z.array(z.string().regex(/^\d{8,15}$/)).min(1).max(MAX_LEAD_WHATSAPP_BATCH_SIZE),
  lookups: z.array(z.object({
    phone: z.string().regex(/^\d{8,15}$/),
    primary: z.string().regex(/^\d{8,15}$/),
    alternate: z.string().regex(/^\d{8,15}$/).nullable()
  })).min(1).max(MAX_LEAD_WHATSAPP_BATCH_SIZE).optional(),
  entries: z.array(z.object({
    verificationId: z.string().uuid(),
    leadId: z.string().uuid(),
    phone: z.string().regex(/^\d{8,15}$/)
  })).min(1)
});

type WhatsappRepository = Pick<
  LeadsRepositoryLike,
  "getWhatsappVerificationContext" | "createWhatsappVerificationJobs" | "fencedFinishWhatsappVerificationJob"
>;

export interface LeadWhatsappServiceOptions {
  repository: WhatsappRepository;
  evolution: {
    checkWhatsappNumbersAvailability(input: { instanceName: string; numbers: string[] }): Promise<CheckWhatsappNumbersAvailabilityResult>;
  };
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

function normalizedPhone(value: unknown) {
  if (typeof value !== "string") return null;
  const phone = canonicalizePhone(value);
  return /^\d{8,15}$/.test(phone) ? phone : null;
}

function jsonStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function transient(error: unknown) {
  return error instanceof EvolutionClientError
    ? error.statusCode === 429 || error.statusCode >= 500
    : error instanceof TypeError || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
}

function safeFailure(error: unknown) {
  if (error instanceof EvolutionClientError) return `LEAD_WHATSAPP_EVOLUTION_${error.statusCode}`;
  if (error instanceof Error && error.message === "EVOLUTION_AVAILABILITY_INVALID_RESPONSE") {
    return "LEAD_WHATSAPP_INVALID_RESPONSE";
  }
  return transient(error) ? "LEAD_WHATSAPP_TEMPORARY_FAILURE" : "LEAD_WHATSAPP_FAILED";
}

function availabilityMap(results: WhatsappNumberAvailability[]) {
  const map = new Map<string, WhatsappNumberAvailability>();
  for (const result of results) {
    const phone = normalizedPhone(result.phone);
    if (phone && (!map.has(phone) || result.available)) map.set(phone, result);
  }
  return map;
}

export function whatsappJobInstanceName(job: Pick<ClaimedLeadJob, "operation" | "input">) {
  if (!isWhatsappAvailabilityOperation(job.operation)) return null;
  const parsed = whatsappJobInputSchema.safeParse(job.input);
  return parsed.success ? parsed.data.instanceName : null;
}

export function isWhatsappAvailabilityOperation(operation: string) {
  return operation === "whatsapp_availability" || operation === "whatsapp_availability_batch";
}

export function createLeadWhatsappService(options: LeadWhatsappServiceOptions) {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  async function checkNumbers(instanceName: string, numbers: string[]) {
    let response: CheckWhatsappNumbersAvailabilityResult | null = null;
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await options.evolution.checkWhatsappNumbersAvailability({ instanceName, numbers });
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        if (!transient(error) || attempt === 2) break;
        await sleep(attempt === 0 ? 250 : 500);
      }
    }
    return { byPhone: response ? availabilityMap(response.numbers) : new Map<string, WhatsappNumberAvailability>(), failure };
  }

  return {
    async createVerification(input: {
      workspaceId: string;
      listId: string;
      leadIds: string[];
      idempotencyKey: string;
    }) {
      const request = leadWhatsappVerificationRequestSchema.safeParse(input);
      if (!request.success || !input.workspaceId.trim()) {
        throw new LeadsDomainError("LEAD_INVALID_INPUT", "WhatsApp verification request is invalid.");
      }
      const context = await options.repository.getWhatsappVerificationContext(
        input.workspaceId,
        request.data.listId,
        request.data.leadIds
      );
      const byPhone = new Map<string, { candidates: WhatsappPhoneCandidates; leadIds: Set<string> }>();
      for (const lead of context.leads) {
        const candidates = [lead.normalizedPhone, ...jsonStrings(lead.phones)];
        for (const candidate of candidates) {
          if (typeof candidate !== "string") continue;
          const lookup = whatsappPhoneCandidates(candidate);
          if (!lookup) continue;
          const group = byPhone.get(lookup.key) ?? { candidates: lookup, leadIds: new Set<string>() };
          if (lookup.primary.length === 13 && group.candidates.primary.length === 12) group.candidates = lookup;
          group.leadIds.add(lead.id);
          byPhone.set(lookup.key, group);
        }
      }
      if (byPhone.size === 0) {
        throw new LeadsDomainError("LEAD_INVALID_INPUT", "Selected leads do not contain a valid phone number.");
      }
      if (byPhone.size > MAX_LEAD_WHATSAPP_UNIQUE_NUMBERS) {
        throw new LeadsDomainError(
          "LEAD_LIMIT_EXCEEDED",
          `WhatsApp verification is limited to ${MAX_LEAD_WHATSAPP_UNIQUE_NUMBERS} unique numbers per request.`
        );
      }
      const entries = [...byPhone].map(([phone, group]) => ({
        phone,
        primary: group.candidates.primary,
        alternate: group.candidates.alternate,
        leadIds: [...group.leadIds]
      }));
      const batches = Array.from(
        { length: Math.ceil(entries.length / MAX_LEAD_WHATSAPP_BATCH_SIZE) },
        (_, index) => entries.slice(index * MAX_LEAD_WHATSAPP_BATCH_SIZE, (index + 1) * MAX_LEAD_WHATSAPP_BATCH_SIZE)
      );
      const requestFingerprint = createHash("sha256")
        .update(JSON.stringify({ listId: request.data.listId, leadIds: [...request.data.leadIds].sort() }))
        .digest("hex");
      return options.repository.createWhatsappVerificationJobs({
        workspaceId: input.workspaceId,
        listId: request.data.listId,
        channelId: context.channel.id,
        instanceName: context.channel.providerKey.trim(),
        idempotencyKey: request.data.idempotencyKey,
        requestId: randomUUID(),
        requestFingerprint,
        batches
      });
    },

    async processClaimedJob(job: ClaimedLeadJob) {
      const input = whatsappJobInputSchema.safeParse(job.input);
      if (!input.success) {
        throw new LeadsDomainError("LEAD_INVALID_INPUT", "Persisted WhatsApp verification job is invalid.");
      }
      const lookups = input.data.lookups ?? input.data.numbers.map((number) => {
        const candidates = whatsappPhoneCandidates(number);
        if (!candidates) throw new LeadsDomainError("LEAD_INVALID_INPUT", "Persisted WhatsApp number is invalid.");
        return { phone: candidates.key, primary: candidates.primary, alternate: candidates.alternate };
      });
      const lookupByPhone = new Map(lookups.map((lookup) => [lookup.phone, lookup]));
      if (lookups.length !== input.data.numbers.length || lookupByPhone.size !== lookups.length ||
          lookups.some((lookup, index) => lookup.primary !== input.data.numbers[index] ||
            normalizedPhone(lookup.primary) !== lookup.phone ||
            (lookup.alternate !== null && normalizedPhone(lookup.alternate) !== lookup.phone)) ||
          input.data.entries.some((entry) => !lookupByPhone.has(entry.phone))) {
        throw new LeadsDomainError("LEAD_INVALID_INPUT", "Persisted WhatsApp lookup does not match its entries.");
      }

      const primary = await checkNumbers(input.data.instanceName, input.data.numbers);
      const needingAlternate = primary.failure === undefined
        ? lookups.filter((lookup) => lookup.alternate && !primary.byPhone.get(lookup.phone)?.available)
        : [];
      const alternate = needingAlternate.length
        ? await checkNumbers(input.data.instanceName, needingAlternate.map((lookup) => lookup.alternate!))
        : null;
      const results = input.data.entries.map((entry) => {
        const lookup = lookupByPhone.get(entry.phone)!;
        const first = primary.byPhone.get(entry.phone);
        const second = lookup.alternate ? alternate?.byPhone.get(entry.phone) : null;
        if (first?.available || second?.available) {
          return { verificationId: entry.verificationId, status: "available" as const, errorMessage: null };
        }
        if (primary.failure !== undefined || (lookup.alternate && alternate?.failure !== undefined)) {
          return {
            verificationId: entry.verificationId,
            status: "failed" as const,
            errorMessage: safeFailure(primary.failure ?? alternate?.failure)
          };
        }
        if (!first || (lookup.alternate && !second)) {
          return { verificationId: entry.verificationId, status: "failed" as const, errorMessage: "LEAD_WHATSAPP_RESULT_MISSING" };
        }
        return {
          verificationId: entry.verificationId,
          status: "unavailable" as const,
          errorMessage: null
        };
      });
      try {
        return await options.repository.fencedFinishWhatsappVerificationJob({ job, now: now(), results });
      } catch (error) {
        if (error instanceof LeadLeaseLostError) throw error;
        throw error;
      }
    }
  };
}

export type LeadWhatsappService = ReturnType<typeof createLeadWhatsappService>;
