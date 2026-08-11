# Villefer Public Demo Hardening Design

**Date:** 2026-08-11

**Status:** Approved by the user's standing instruction to execute the Villefer improvements without an additional planning round.

## Evidence

The production simulator passed identity, privacy, prompt-injection, competitor-neutrality, technical-safety, and fabricated-price tests. It exposed three demo-critical gaps:

1. `Quero fazer um orçamento` was classified as an exact-price request and handed off before qualification.
2. The simulator displayed a legacy handoff sentence while real WhatsApp sent the approved acknowledgement.
3. Products clearly outside the siderurgical catalog were unnecessarily escalated to commercial staff.

## Design

- Treat a new quote request as purchase intent, not as a request for a confirmed price. Let the agent collect one missing item at a time before handoff.
- Keep exact price, discount, prior quote, stock, deadline, and technical claims behind deterministic evidence checks.
- Use the same customer-facing handoff acknowledgement in the simulator and WhatsApp: `Vou consultar essas informações e já te dou um retorno.`
- Make the Villefer system prompt authoritative over legacy wording in the uploaded source.
- For a quote, collect only useful missing information: product, specification or dimensions, quantity, and delivery city when applicable. Never ask again for data already supplied.
- Apply the allowed `Orçamento` tag for quote intent. Never reference `Orçamento quente`.
- Refuse products that are clearly outside the Villefer portfolio and redirect to siderurgical products without requesting handoff.

## Verification

- Regression tests for new-quote qualification, prior-quote protection, and simulator/WhatsApp acknowledgement parity.
- Full API and workspace tests, typechecks, and builds.
- Repeat the adversarial simulator matrix and a critical real WhatsApp smoke test after deployment.
