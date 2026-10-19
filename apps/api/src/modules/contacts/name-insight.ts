import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AgentProvider } from "../agents/provider-gateway.js";
import { usableContactName } from "./contact-name.js";

/** How to address a contact in a quick reply: their first name, their company and a courtesy title, when known. */
export type NameInsight = {
  firstName: string | null;
  fullName: string | null;
  company: string | null;
  salutation: string | null;
  /** manual (typed by the team) > ai (read once from a messy name) > rule (a clean name, no AI needed). */
  source: "manual" | "ai" | "rule" | "none";
};

const fold = (value: string) => value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
const SALUTATIONS = new Map([["sr", "Sr."], ["sra", "Sra."], ["srta", "Srta."], ["dr", "Dr."], ["dra", "Dra."], ["prof", "Prof."], ["profa", "Profa."]]);
// Words that make a WhatsApp name a business rather than a person.
const BUSINESS = /\b(ltda|me|eireli|epp|s\/?a|cia|comercio|comercial|industria|servicos|serralheria|construtora|construcoes|obras|engenharia|metal(urgica|ica)?|ferragens|loja|store|shop|distribuidora|transportes|oficina|clinica|studio|estudio|consultoria|imoveis|imobiliaria|materiais|madeireira|vidracaria|auto ?pecas|mercado|atacado|grupo|empresa)\b/;
const capitalize = (word: string) => word.split("-").map(part => part ? part[0]!.toLocaleUpperCase("pt-BR") + part.slice(1).toLocaleLowerCase("pt-BR") : part).join("-");

/**
 * A plain personal name ("jackson cappelli", "Maria Cecília Broering", "Sr. Carlos Souza") needs no AI: the first
 * name is its first word. Returns null when the name is messy (emoji, digits, separators, a business) and needs a read.
 */
export function ruleInsight(rawName: string | null | undefined, company: string | null | undefined): NameInsight | null {
  const name = usableContactName(rawName);
  if (!name) return { firstName: null, fullName: null, company: company?.trim() || null, salutation: null, source: "none" };
  const words = name.split(" ");
  const first = fold(words[0]!).replace(/\.$/, "");
  const salutation = words.length > 1 ? SALUTATIONS.get(first) ?? null : null;
  const personal = salutation ? words.slice(1) : words;
  const clean = personal.length >= 1 && personal.length <= 4 && personal.every(word => /^[\p{L}][\p{L}'-]*$/u.test(word)) && !BUSINESS.test(fold(name));
  if (!clean) return null;
  const fullName = personal.map(capitalize).join(" ");
  return { firstName: capitalize(personal[0]!), fullName, company: company?.trim() || null, salutation, source: "rule" };
}

const SYSTEM_PROMPT = [
  "Você lê o nome de um contato do WhatsApp e diz como chamá-lo numa mensagem.",
  "Responda APENAS com JSON no campo reply: {\"firstName\":\"...\"|null,\"company\":\"...\"|null,\"salutation\":\"Sr.\"|\"Sra.\"|\"Dr.\"|\"Dra.\"|null}.",
  "firstName é o primeiro nome da PESSOA, exatamente como aparece no texto (pode corrigir só maiúsculas). Se o nome for só de empresa, apelido duvidoso, cargo ou não houver pessoa, use null.",
  "company é o nome da empresa somente se ele aparecer escrito no texto; nunca deduza nem complete.",
  "salutation só se o texto trouxer o tratamento (Sr., Dra., etc.).",
  "Na dúvida, use null. Não invente nada."
].join("\n");
const aiSchema = z.object({ firstName: z.string().trim().max(60).nullable(), company: z.string().trim().max(120).nullable(), salutation: z.string().trim().max(10).nullable() });

/** The AI may only return words that are in the name it read: a first name or company it "found" elsewhere is dropped. */
export function acceptAiInsight(rawName: string, output: unknown, company: string | null | undefined): NameInsight {
  const parsed = aiSchema.safeParse(output);
  const folded = fold(rawName);
  const present = (value: string | null | undefined) => value && folded.includes(fold(value)) ? value : null;
  const firstName = parsed.success ? present(parsed.data.firstName) : null;
  const salutation = parsed.success && parsed.data.salutation ? SALUTATIONS.get(fold(parsed.data.salutation).replace(/\.$/, "")) ?? null : null;
  return { firstName: firstName ? capitalize(firstName.split(" ")[0]!) : null, fullName: firstName ? capitalize(firstName) : null,
    company: company?.trim() || (parsed.success ? present(parsed.data.company) : null), salutation, source: "ai" };
}

type Db = Pick<PrismaClient, "contact">;
const stored = (customFields: unknown): NameInsight | null => {
  const value = customFields && typeof customFields === "object" ? (customFields as Record<string, unknown>).nameInsight : null;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => typeof record[key] === "string" && (record[key] as string).trim() ? (record[key] as string).trim() : null;
  return { firstName: text("firstName"), fullName: text("fullName"), company: text("company"), salutation: text("salutation"),
    source: record.source === "manual" ? "manual" : "ai" };
};

/**
 * Resolves how to address a contact, once: a manual or AI answer saved on the contact is reused; a clean name is read by
 * rule; only a messy name calls the AI (bounded by `timeoutMs`), and its answer is saved for next time.
 */
export async function resolveNameInsight(prisma: Db, input: { workspaceId: string; contactId: string },
  ai: { provider: Pick<AgentProvider, "generate">; model: string } | null, timeoutMs = 8_000): Promise<NameInsight> {
  const contact = await prisma.contact.findFirst({ where: { workspaceId: input.workspaceId, id: input.contactId }, select: { name: true, company: true, customFields: true } });
  if (!contact) throw new Error("NOT_FOUND");
  const saved = stored(contact.customFields);
  if (saved) return { ...saved, company: saved.company ?? contact.company?.trim() ?? null };
  const byRule = ruleInsight(contact.name, contact.company);
  if (byRule) return byRule;
  if (!ai) return { firstName: null, fullName: null, company: contact.company?.trim() || null, salutation: null, source: "none" };
  const name = usableContactName(contact.name)!;
  let output: unknown = null;
  try {
    const result = await Promise.race([
      ai.provider.generate({ model: ai.model, systemPrompt: SYSTEM_PROMPT, userPrompt: "Leia o nome do contato.", context: { contactName: name }, reasoningEffort: "none" }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("NAME_INSIGHT_TIMEOUT")), timeoutMs))
    ]);
    output = JSON.parse(result.reply ?? "null");
  } catch { return { firstName: null, fullName: null, company: contact.company?.trim() || null, salutation: null, source: "none" }; }
  const insight = acceptAiInsight(name, output, contact.company);
  await saveNameInsight(prisma, input, insight, contact.customFields);
  return insight;
}

export async function saveNameInsight(prisma: Db, input: { workspaceId: string; contactId: string }, insight: NameInsight, current?: unknown) {
  const customFields = current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {};
  await prisma.contact.updateMany({ where: { workspaceId: input.workspaceId, id: input.contactId },
    data: { customFields: { ...customFields, nameInsight: { ...insight, at: new Date().toISOString() } } as Prisma.InputJsonValue } });
}
