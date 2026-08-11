export const MAX_WHATSAPP_AGENT_REPLY_CHARS = 500;

export type WhatsAppReplyPolicyResult = {
  reply: string;
  compacted: boolean;
  originalCharacters: number;
};

const HANDOFF_UNIT = /encaminh|comercial|especialista|atendente/i;
const TERMINAL_PUNCTUATION = /[.!?…]$/u;

export function enforceWhatsAppReply(reply: string): WhatsAppReplyPolicyResult {
  const normalized = reply
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (normalized.length <= MAX_WHATSAPP_AGENT_REPLY_CHARS) {
    return {
      reply: normalized,
      compacted: false,
      originalCharacters: normalized.length
    };
  }

  const units = normalized
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((unit) => unit.trim())
    .filter(Boolean);
  const handoff = [...units].reverse().find((unit) => HANDOFF_UNIT.test(unit));
  const selected: string[] = [];

  for (const unit of units) {
    if (unit === handoff) {
      continue;
    }

    const candidate = [...selected, unit, ...(handoff ? [handoff] : [])].join(" ");
    if (`${candidate}…`.length > MAX_WHATSAPP_AGENT_REPLY_CHARS) {
      break;
    }
    selected.push(unit);
  }

  let compacted = [...selected, ...(handoff ? [handoff] : [])].join(" ").trim();
  if (!compacted) {
    compacted = "Vou confirmar essa informação com o time e continuar o atendimento com segurança.";
  }

  if (compacted.length >= MAX_WHATSAPP_AGENT_REPLY_CHARS) {
    compacted = truncateWithoutSplittingUnicode(
      compacted,
      MAX_WHATSAPP_AGENT_REPLY_CHARS - 1
    ).trimEnd();
  }
  if (!TERMINAL_PUNCTUATION.test(compacted)) {
    compacted += "…";
  }

  return {
    reply: compacted,
    compacted: true,
    originalCharacters: normalized.length
  };
}

function truncateWithoutSplittingUnicode(value: string, maxCodeUnits: number) {
  let truncated = value.slice(0, maxCodeUnits);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}
