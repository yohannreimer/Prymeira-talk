const fallback = 'Esta conversa precisa da sua atenção. Abra para conferir o contexto.';
const reasons: Record<string, string> = {
  automated_reception_wait: 'O contato respondeu com um atendimento automático. Confira a conversa.',
  possible_automation_loop: 'A IA identificou uma possível troca de mensagens automáticas. Confira a conversa.',
  user_emergency_stop_all_ai: 'A IA foi pausada por você. Revise a conversa antes de retomar o atendimento.',
  low_confidence: 'A IA ficou em dúvida sobre como responder. Revise a conversa.',
  human_requested: 'O cliente pediu para falar com uma pessoa.',
  commercial_policy_risk: 'A resposta precisa de revisão das condições comerciais.',
  recusa: 'O contato recusou a abordagem. Confira a conversa antes de continuar.',
  buyer_recap_review: 'O resumo da negociação precisa da sua revisão.',
};
/** Keep clear human explanations; never show unknown machine codes as product copy. */
export function humanReason(reason: string | null | undefined): string {
  const value = reason?.trim();
  if (!value) return fallback;
  const key = value.toLowerCase();
  if (reasons[key]) return reasons[key];
  if (/^prospecting binding requires review\s*:/i.test(value)) return 'O vínculo desta conversa com a prospecção precisa ser revisado no Talk.';
  if (/buyer[\s_:-]+recap[\s_:-]+review/i.test(value)) return reasons.buyer_recap_review!;
  if (/[a-z0-9]+_[a-z0-9_]+/i.test(value) || /\b(prospecting|binding|requires|buyer|recap|review|automated|reception)\b/i.test(value)) return fallback;
  return value;
}
