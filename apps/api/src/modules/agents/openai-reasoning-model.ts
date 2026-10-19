export function usesOpenAiReasoningParameters(model: string): boolean {
  return /^gpt-(?:5\.6|6)(?:[.-]|$)/i.test(model.trim());
}
