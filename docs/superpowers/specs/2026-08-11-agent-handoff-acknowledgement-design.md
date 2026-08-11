# Agent Handoff Acknowledgement Design

## Context

The Villefer agent runs on the seller's own WhatsApp number. When the agent needs human help, the seller continues the same conversation from the same account; there is no visible transfer to another person or channel.

The production test exposed a gap: the runtime correctly marked the conversation as `handoff_requested`, but suppressed the safe reply that should acknowledge the customer's request. The customer therefore saw silence while the seller saw `Humano necessário` in Prymeira Talk.

## Considered approaches

1. **Silent handoff.** Pause the agent without replying. This is operationally simple but leaves the customer unsure whether the message was understood.
2. **Generated handoff reply.** Send the model's reply before pausing. This is more contextual but can repeat an uncertain price, stock, deadline, or technical claim—the exact content that caused the handoff.
3. **Fixed acknowledgement.** Send one neutral, deterministic sentence and then pause the agent. This is the selected approach because it reassures the customer without inventing facts and gives the seller a recognizable signal to take over.

## Customer-facing behavior

Whenever a run ends as `handoff_requested` and the agent is allowed to send messages, Prymeira Talk sends exactly:

> Vou consultar essas informações e já te dou um retorno.

The message must be used for safety-triggered handoffs, low-confidence handoffs, explicit `request_handoff` actions, and direct requests for human service. The generated model reply must not be sent for these runs.

After the acknowledgement is sent, the existing handoff behavior remains unchanged:

- the AI session becomes `handoff_requested`;
- the conversation is marked `Humano necessário`;
- the seller sees the conversation in the active queue and continues from the same WhatsApp number;
- subsequent automation does not answer while the session is paused for human action.

## Runtime design

The agent runtime will choose the outbound text after it calculates `handoffReason`:

- when there is no handoff, it sends the provider's compacted reply as today;
- when there is a handoff, it ignores the provider reply and sends the fixed acknowledgement;
- when `send_message` is not allowed, it changes the handoff state without creating or sending an outbound message.

The persisted outbound message, conversation preview, Evolution payload, and realtime event must all contain the same selected outbound text. The agent run output remains available for audit, but uncertain provider text is never delivered to the customer.

## Failure handling

The state transition must not claim a successful customer acknowledgement if the Evolution send fails. The existing provider error path remains responsible for failing the run, allowing operational logs and retry behavior to expose the delivery problem instead of silently marking the handoff complete.

## Verification

Add focused runtime tests covering:

- a safety handoff sends the fixed acknowledgement through Evolution and stores it as the outbound message;
- a high-confidence provider output containing `request_handoff` sends the fixed acknowledgement instead of the provider reply;
- a low-confidence output sends the fixed acknowledgement instead of uncertain text;
- a handoff without `send_message` permission changes state without sending or persisting an outbound message;
- an ordinary completed run continues sending the provider reply unchanged.

After deployment, repeat the real WhatsApp price/stock/deadline scenario and verify both sides: the customer receives the fixed acknowledgement and Prymeira Talk shows `Humano necessário` for the seller.
