export function buildProspectingInstructions(systemPrompt: string, goal: unknown, context?: string | null) {
  return `${systemPrompt}\nObjetivo da prospecção: ${typeof goal === 'string' ? goal : ''}\nContexto da oferta da campanha: ${context ?? ''}\nRespeite recusas e encerre acompanhamentos. Ao atingir o objetivo, solicite transferência ao atendimento humano com um resumo.`;
}
