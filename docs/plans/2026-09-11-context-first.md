# Context-first pilot — approved direction

The user approved implementation, sequentially: read the conversation, understand its stage and speaker roles, reuse known facts and ask only what advances the current exchange. Do not activate an agent/channel or send WhatsApp messages.

## Design

- Explicit `behaviorConfig.conversationReasoning = "context_first_v1"` opt-in; existing agents keep their behavior.
- Business keyword decisions become advisory for opted-in agents; the model chooses qualification, continuation, closure or handoff. Keep injection, explicit-human and missing-media guards, approved-fact constraints and human-control checks.
- One concise prompt hierarchy: speaker ownership and current stage before the qualification checklist. Supplier messages are not sales leads. A name used to address the seller is not the contact's name.
- Read all messages stored in this Talk conversation, up to explicit safety limits (2,000 messages / 120,000 characters). Fail visibly above limits, never silently advertise a truncated history as complete. This does not import missing Evolution history or merge other conversations.
- Preserve a valid nested handoff reason when the model supplies it.

## Execution and verification

1. Add failing regressions for model reachability on commercial questions, nested handoff reasons and history beyond 80 messages.
2. Implement opt-in consistently in test chat, runtime and private assistant; simplify Villefer template.
3. Run focused tests, API suite, typecheck and production build.
4. Replay failed and control historical cases with real provider in an isolated read-only service. Inspect replies AND proposed notes/actions. Report limits; no blanket approval.
5. Apply only validated test-agent configuration. Any production image rollout must preserve private replay evidence and all active-agent/channel settings.

Self-review: no industry keywords added to the generic policy; no new model, price source or sending authority. Unit tests prove routing, not language quality; real replays are required separately.
