/** This error is created only around model generation, before any business action
 * or customer dispatch. A generic runtime/provider-send error must never acquire
 * retry permission merely because its text mentions a timeout. */
export class AgentGenerationFailure extends Error {
  readonly retryable: boolean;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'AI generation failed.', { cause });
    this.name = 'AgentGenerationFailure';
    const data = typeof cause === 'object' && cause !== null ? cause as Record<string, unknown> : {};
    const explicit = Number(data.statusCode ?? data.status);
    const fromText = /\b(?:status|HTTP)\s+(\d{3})\b/i.exec(this.message)?.[1];
    const status = Number.isFinite(explicit) && explicit > 0 ? explicit : Number(fromText);
    // Authentication, model/configuration and other client errors require an
    // operator. Throttling and pre-dispatch network/format failures get a budget.
    this.retryable = status > 0 ? status === 408 || status === 429 || status >= 500 : true;
  }
}

export class AgentProviderUnavailable extends Error {
  readonly code = 'AI_PROVIDER_UNAVAILABLE';
  constructor() {
    super('O provedor de IA não está configurado. Atendimento encaminhado para uma pessoa do time.');
    this.name = 'AgentProviderUnavailable';
  }
}
