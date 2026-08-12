# Villefer Exploratory Boundaries Design

**Date:** 2026-08-12

**Status:** Implemented and verified

## Context

The exploratory simulator matrix covered product discovery, material comparisons, beginner questions, applications, technical limits, logistics, objections, and a continuous six-message discovery conversation. The agent was generally useful and safe, but three reproducible gaps remain:

1. `pronta entrega` is classified as an exact delivery-deadline request because the deadline rule matches the isolated word `entrega`.
2. The provider can assert that Villefer serves individuals or sells one unit even though the knowledge base does not confirm those commercial conditions.
3. When asked whether Villefer designs a structure, the agent asks for project data instead of directly explaining that it does not perform engineering design or structural sizing.

## Approved behavior

### Pronta entrega versus delivery deadline

- Questions about the meaning or difference of `pronta entrega` remain exploratory and go to the model.
- Specific delivery commitments, locations, dates, or durations remain protected and require confirmed evidence or handoff.
- `pronta entrega` never means that a particular product, dimension, or quantity is currently in stock.

### Commercial eligibility and minimum quantity

- The agent must not confirm service to individuals, counter sales, walk-in sales, sale of a single piece, or a minimum order without official evidence.
- It may say that the condition needs confirmation and ask what product the customer needs.
- Exact stock, current availability, delivery, and price continue to use deterministic handoff rules.

### Engineering and design

- When asked whether Villefer designs, sizes, calculates, approves, or takes technical responsibility for a structure, answer directly that the assistant cannot provide engineering design or structural sizing.
- It may explain that a drawing, bill of materials, photo, and measurements can be reviewed for product-supply feasibility.
- It must not imply that Villefer will create or approve the engineering project.

## Image-list behavior

This design originally documented the pre-multimodal limitation: Evolution stored the image but the provider received only its caption. That temporary limitation is superseded by `2026-08-12-agent-multimodal-input-design.md`, which defines bounded vision and audio processing while preserving the commercial and engineering boundaries above.

## Verification

- Add regression cases for exploratory `pronta entrega` questions versus actual deadline requests.
- Repeat the person/one-piece/design simulator cases after updating the Villefer prompt.
- Run the complete test, typecheck, and build suites.
- Publish the API and re-run the exploratory production matrix.
