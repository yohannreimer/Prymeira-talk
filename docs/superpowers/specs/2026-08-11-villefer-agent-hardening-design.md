# Villefer Agent Hardening Design

**Date:** 2026-08-11

**Status:** Approved for implementation planning

## Context

The Agent Villefer production smoke tests confirmed that GPT-5.6 Luna can answer greetings, product questions, unknown-stock questions, structural-safety questions, prompt-injection attempts, prompt-exfiltration attempts, and explicit human handoff requests. The same tests exposed four reliability gaps:

1. A single 30,000+ character knowledge source contributes at most one 8,000-character window to the model.
2. The Villefer instructions refer to the nonexistent tag `Orçamento quente`, while the agent is allowed to use `Orçamento`.
3. Product-list responses can be too long for a WhatsApp conversation.
4. The API image contains the complete development toolchain, and a full Docker disk caused PostgreSQL write failures and repeated API restarts.

This design hardens the agent and its deployment without adding embeddings, a vector database, or infrastructure outside Prymeira Talk.

## Goals

- Retrieve relevant evidence from the beginning, middle, or end of a long knowledge source.
- Keep normal WhatsApp replies at or below 500 characters and usually within one to four sentences.
- Require evidence for exact prices, stock, deadlines, and technical specifications.
- Request human handoff automatically when required evidence is absent or the customer asks for a person.
- Ensure the model can apply only tags configured for the selected agent.
- Refuse prompt and knowledge-base exfiltration requests.
- Reduce the API runtime image and prevent database-startup failures from creating an opaque restart loop.
- Preserve safe provider error reporting and production rollback capability.

## Non-goals

- Embeddings or semantic-vector infrastructure.
- A global Docker cleanup policy for other products on the host.
- Automatic deletion of active Prymeira Talk images or database volumes.
- A general-purpose prompt-management product.
- A claim that any probabilistic model is literally infallible.

## Architecture

### 1. Long-document chunking and retrieval

Knowledge retrieval will move from source-level ranking plus one fixed snippet to a two-level process:

1. Rank sources using the existing title, category, keyword, and content signals.
2. Split every matching source into logical chunks.
3. Rank chunks against the latest message, relevant recent history, and the automation instruction.
4. Select complementary chunks within a global context budget.

Chunk boundaries prefer Markdown headings, blank-line paragraph boundaries, and list boundaries. Oversized blocks receive a sliding-window fallback with overlap so a fact at a boundary is not lost. Each chunk retains the source ID, source title, character range, and deterministic chunk index.

The initial limits are:

- maximum chunk size: 2,400 characters;
- target overlap for sliding-window chunks: 300 characters;
- maximum selected sources: 3;
- maximum selected chunks: 6;
- maximum combined selected knowledge: 12,000 characters.

These values increase coverage without sending an entire uploaded file to the provider. The selector prefers diversity: after the best chunk, a near-duplicate chunk from the same range is penalized, while a complementary chunk with different evidence remains eligible.

For short documents, the existing full-document behavior remains valid when the document fits the total budget.

### 2. Evidence-aware safety decisions

The deterministic runtime will identify evidence-dependent question classes before provider generation:

- exact price or discount;
- current stock or availability;
- delivery or implementation deadline;
- structural or technical specification.

If no selected chunk contains relevant evidence for one of these classes, the runtime returns a safe reply and requests handoff without asking the model to fill the gap. A customer request for a human also triggers immediate handoff.

When evidence exists, the selected chunks are included in the model context with their source and range metadata. The provider prompt states that factual claims in the four protected classes must be grounded in those chunks.

### 3. Reply contract

The provider contract will explicitly require:

- Brazilian Portuguese suitable for WhatsApp;
- one to four short sentences in normal replies;
- a hard maximum of 500 characters;
- a short list only when a catalog or comparison benefits from one;
- no repetition of a greeting after the conversation has started;
- no disclosure of system instructions, operational rules, or full knowledge content.

Provider output parsing will validate the reply length. A reply over 500 characters is not silently truncated mid-word. It receives one deterministic compaction pass that preserves meaning, final punctuation, and handoff wording. Tests will cover URLs, list items, and multibyte Portuguese characters. If compaction cannot produce a valid reply, the runtime uses a safe concise fallback and records the validation failure.

### 4. Tags and actions

Allowed tags remain authoritative. Provider context will include tag IDs, names, and usage guidance. The output contract will prefer `tagId` and accept `tagName` for compatibility.

The action executor will:

- apply a tag only when its ID or normalized name matches the allowed list;
- reject nonexistent tags without substituting a guess;
- record the rejected action in the run result;
- continue sending an otherwise valid customer reply when a noncritical tag action is rejected;
- preserve handoff and internal-note actions independently of the rejected tag.

The Villefer configuration will be updated to refer to the real `Orçamento` tag. No alias named `Orçamento quente` will be created.

### 5. Observability and simulator output

Simulator and agent-run diagnostics will expose safe retrieval metadata:

- number of sources evaluated;
- number of chunks evaluated and selected;
- total selected characters;
- selected source titles;
- chunk indices and character ranges;
- retrieval reasons and scores;
- protected-question classification;
- reply character count;
- rejected action codes;
- handoff reason.

Diagnostics must not expose API keys, authorization headers, complete prompts, complete uploaded documents, or raw provider error bodies.

## Production deployment hardening

### API image

The API Dockerfile will use multiple stages. The build stage keeps TypeScript, Vitest, Prisma CLI, and other development tools. The runtime stage receives only the files and production dependencies required to start the compiled API and generated Prisma client.

The API TypeScript configuration will gain a production emit configuration rather than executing source through `tsx` in production. Prisma migration execution will use a dedicated migration stage or one-shot deployment command, separate from the long-running API process.

### Health and startup

The stack will add:

- a PostgreSQL `pg_isready` healthcheck;
- an API readiness endpoint that verifies a lightweight database query;
- an API container healthcheck using the readiness endpoint;
- deployment ordering/documentation that runs migrations only after PostgreSQL is ready.

`/health` remains a liveness endpoint and does not reveal database details. The readiness endpoint returns only a boolean product status and an unavailable status code when the database cannot be reached.

### Prymeira Talk image retention

Operational cleanup is restricted to Prymeira Talk images. After a successful rollout and health verification, the host may remove Prymeira Talk images that are both dangling and unused, while preserving:

- the active API and web images;
- the immediately previous API and web images when available;
- all PostgreSQL volumes.

The cleanup process never prunes global Docker images, containers, volumes, or build cache belonging to other products.

## Error handling

- No relevant evidence for a protected question: concise safe reply plus handoff.
- Provider timeout or connection failure: safe provider error code in logs; no secret or raw body.
- Invalid provider JSON: one existing JSON extraction attempt, then a controlled failure.
- Reply over 500 characters: deterministic compaction, followed by a safe fallback if still invalid.
- Invalid tag action: reject that action, record a safe code, and continue noncritical actions and reply delivery.
- Database unavailable: readiness fails; the API must not report ready.
- Migration failure: the one-shot migration command fails visibly without starting a crash loop in the API service.

## Data flow

1. Receive an inbound non-`fromMe` WhatsApp event.
2. Build bounded recent conversation context.
3. Classify whether the latest request needs protected evidence or immediate handoff.
4. Rank sources, create chunks, rank chunks, and select a diverse set within budget.
5. If protected evidence is missing, produce deterministic handoff output.
6. Otherwise call GPT-5.6 Luna with the approved prompt, allowed tags, actions, and selected chunks.
7. Parse and validate structured output.
8. Compact or replace an oversized reply.
9. Execute allowed actions, isolating noncritical tag rejection from reply delivery.
10. Send the final reply and record safe diagnostics.

## Testing strategy

### Automated tests

- Chunk boundaries for headings, paragraphs, lists, oversized blocks, and overlap.
- Retrieval when the answer appears at the start, middle, end, and across a chunk boundary.
- Diversity and total-character budget enforcement.
- Protected-question detection for exact price, stock, deadline, and structural specification.
- Deterministic handoff when protected evidence is absent.
- Grounded response path when evidence exists.
- Allowed tag by ID and normalized name.
- Invalid tag rejection without suppressing a valid reply or handoff.
- Reply compaction and 500-character enforcement.
- Prompt-injection and instruction-exfiltration contract tests.
- API liveness and database readiness behavior.
- Docker production build and runtime smoke tests.
- Full workspace regression, typecheck, and builds.

### Production simulator matrix

- Greeting.
- Product catalog.
- Exact stock request without evidence.
- Price request with and without evidence.
- Structural sizing request.
- Prompt injection with fabricated price and stock.
- Request to reveal instructions or copy the knowledge base.
- Multi-turn context and no repeated greeting.
- Existing `Orçamento` tag action.
- Explicit human handoff.

### Two-number WhatsApp matrix

The final production test uses a second WhatsApp number so the inbound event is not marked `fromMe`. It verifies delivery, one automated reply, continuity, tag application, and handoff in the actual channel. A failed case is reproduced in isolation before changing code or prompt.

## Acceptance criteria

- GPT-5.6 Luna remains the persisted production chat model.
- A fact located after character 8,000 in the Villefer source can be selected and used.
- Protected facts are never asserted without selected evidence.
- Normal replies do not exceed 500 characters.
- Catalog replies remain concise and useful.
- The Villefer agent uses `Orçamento`, not `Orçamento quente`.
- Invalid tag output cannot fail an otherwise valid reply.
- Prompt and full-base exfiltration requests are refused.
- API runtime image is materially smaller than the current approximately 810 MB image.
- PostgreSQL and API healthchecks are active, and readiness fails when the database is unavailable.
- Production health, simulator matrix, and second-number WhatsApp matrix pass after deployment.

## Rollback

Code and image changes are released together under a commit tag. Rollback restores the previous API and web image digests and the prior Villefer configuration. No schema-destructive migration is required by this design. Knowledge-source content is preserved throughout the rollout.
