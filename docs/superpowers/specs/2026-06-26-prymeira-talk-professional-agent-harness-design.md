# Prymeira Talk Professional Agent Harness Design

## Context

Prymeira Talk already has the first autonomous agent foundation:

- agent configuration and knowledge records;
- `run_agent` automation blocks;
- conversation-level AI takeover/release;
- agent runs and sessions;
- a simulated provider;
- a simple knowledge context path.

The next step is to make agents genuinely useful in atendimento: they must answer with a real AI model, understand the full conversation, and use small business documents such as price sheets, policies, onboarding PDFs, and product notes as if they had the documents in hand.

The target use case is not a huge document library. The expected files are usually one or two pages. That changes the retrieval strategy: a heavyweight vector-only approach can be less reliable than a short-document harness that classifies, ranks, and injects entire relevant documents when they fit.

## Goals

- Add a real OpenAI-compatible AI provider configuration in Ajustes.
- Let users configure `baseUrl`, `apiKey`, and chat model once per workspace.
- Let an agent use that provider instead of the simulated provider.
- Let users attach short PDFs and text documents to an agent.
- Extract readable text from uploaded PDFs and store it as agent knowledge.
- Let users label documents by business category, such as `precos`, `produto`, `faq`, `politicas`, `onboarding`, or `outro`.
- Give each agent the full conversation history for normal atendimento conversations.
- Retrieve the right documents for the current user message and conversation context.
- Prefer full-document injection for short documents instead of fragile over-chunking.
- Force the model to answer only from prompt, conversation context, and selected documents.
- Log which documents were selected and why.
- Preserve human takeover: when the conversation is human controlled, the agent still does not run.

## Non-Goals

- Do not build a large-scale vector database in this iteration.
- Do not require embeddings for the first production-quality harness.
- Do not implement OCR for scanned PDFs in the first version.
- Do not support very large manuals as the primary path in this iteration.
- Do not let agents browse the internet.
- Do not let agents call arbitrary external tools beyond the existing allowed level 2 actions.
- Do not expose API keys back to the frontend after saving.

## Recommended Approach

Build a `Professional Agent Harness` around three deterministic layers before the model call:

1. **Conversation memory builder**
   Loads the full conversation history in chronological order, including inbound, outbound, internal/system markers where available, and the current inbound message.

2. **Short-document retrieval harness**
   Scores documents using category, title, keyword overlap, exact business terms, and conversation intent. For one-to-two-page documents, inject the entire document when relevant. Only chunk when a document exceeds a safe text-size limit.

3. **Structured OpenAI-compatible provider**
   Calls `/chat/completions` on the configured provider and requires structured JSON output containing reply, confidence, handoff decision, selected source IDs, and safe action plan.

This makes the harness more assertive for small document sets than vector-only retrieval. The model still reasons intelligently, but the system decides which documents it gets using transparent, auditable rules.

## User Experience

### Ajustes

Add an `IA` or `Provider de IA` section in Ajustes.

Fields:

- `Base URL`
  - default suggestion: `https://api.openai.com/v1`
  - OpenRouter example: `https://openrouter.ai/api/v1`
- `API Key`
  - write-only after save;
  - masked as `[redacted]` in API responses;
  - empty/redacted value preserves the previous key.
- `Modelo de chat`
  - examples: `gpt-4.1-mini`, `gpt-4o-mini`, `openai/gpt-4.1-mini`.
- `Status`
  - simulated or real mode using the existing `IntegrationConfig.mode` pattern.

The provider name should be something explicit such as `ai_provider` or `openai_compatible`.

### Agents

The Agentes page should keep the current prompt and FAQ/text knowledge flow, then add:

- document upload;
- document category selector;
- document title;
- extracted text preview;
- source status;
- source type badge: `PDF`, `Texto`, `FAQ`.

For the first version, a PDF upload can be stored as text knowledge after extraction. The important behavior is that the runtime uses the extracted text, not the binary file.

### Agent Test Path

The first manual test can happen through Automacoes and Atendimento:

- configure provider in Ajustes;
- open Agentes and confirm `Secretaria IA`;
- add/upload a short price PDF;
- create or use an automation with `Executar agente`;
- simulate or receive inbound message asking about price;
- verify the agent answers from the price document;
- click `Assumir` and verify future agent runs are skipped;
- click `Liberar IA` and verify future inbound can run again.

## Knowledge Model

The existing `AiKnowledgeSource` model already supports:

- `type`;
- `title`;
- `content`;
- `fileUrl`;
- `fileName`;
- `mimeType`;
- `metadata`.

Use `metadata` to store harness-specific fields without requiring a large migration at first:

```json
{
  "category": "precos",
  "sourceKind": "pdf",
  "pageCount": 2,
  "extractedAt": "2026-06-26T00:00:00.000Z",
  "extractionMethod": "pdf-text",
  "keywords": ["preco", "plano", "mensalidade", "atendente"],
  "textCharCount": 4200
}
```

Recommended categories:

- `precos`
- `produto`
- `faq`
- `politicas`
- `onboarding`
- `comercial`
- `suporte`
- `outro`

The UI should let the user choose the category. Later, the backend can suggest a category after extraction.

## Document Ingestion

For PDF upload:

1. Validate file type and size.
2. Convert file to text on the API.
3. Normalize whitespace.
4. Store extracted text in `AiKnowledgeSource.content`.
5. Store original file metadata in `fileName`, `mimeType`, `metadata`.
6. Mark status as `ready` if text was extracted.
7. Mark status as `failed` with metadata reason if extraction fails.

For short documents:

- If extracted text is below a safe threshold, store and use it as one whole document.
- Suggested initial threshold: roughly 12,000-18,000 characters.
- Do not chunk one-page and two-page documents by default.

For longer documents:

- Store the full text in `content`.
- Create runtime snippets from sections/paragraphs only when needed.
- This can still happen without adding a chunk table in the first iteration.

## Conversation Memory Harness

Every agent run must include conversation history, not only the latest inbound message.

The runtime should load messages for the selected conversation in chronological order:

```txt
[2026-06-26 09:12] cliente: Quero saber os planos.
[2026-06-26 09:13] atendente: Temos plano para operacao pequena e multiatendente.
[2026-06-26 09:14] cliente: E quanto fica para 3 atendentes?
```

The prompt should tell the model:

- read the history before answering;
- treat the latest message as part of the conversation, not as an isolated question;
- resolve references such as "aquele plano", "o mais barato", "pra 3 pessoas", "isso dai";
- do not repeat information already answered unless it helps clarity;
- if the user asks a follow-up, answer the follow-up directly.

Default behavior:

- include the full history for normal atendimento conversations;
- if a future conversation becomes too large, keep the latest messages and add a summary of older messages;
- do not implement summarization until needed.

## Retrieval Harness

The retrieval path should be deterministic and auditable.

### Query Analysis

Before selecting documents, derive simple query signals from:

- latest inbound message;
- recent conversation history;
- agent instruction;
- known categories.

Examples:

- "preco", "valor", "plano", "mensalidade", "quanto custa" -> `precos`
- "cancelar", "reembolso", "contrato" -> `politicas`
- "como funciona", "integracao", "recurso" -> `produto`
- "comecar", "primeiro acesso", "configurar" -> `onboarding`

This does not need to be a separate model call in the first version. A deterministic classifier is easier to test and more predictable.

### Candidate Scoring

Score each ready knowledge source for the agent:

- category match;
- title match;
- keyword match;
- exact phrase overlap;
- normalized token overlap;
- recency as a small tiebreaker.

Recommended behavior for small document sets:

- if there are 1-5 ready documents, evaluate all of them;
- include the top matching documents;
- if one document has a strong category match, include it even if lexical score is only moderate;
- if no document is relevant, do not inject unrelated documents.

### Full-Document Injection

For short documents:

- inject the full document text;
- include title, category, file name, and source ID;
- cap total document context to protect token budget.

Example prompt section:

```txt
DOCUMENTO fonte=doc_123 categoria=precos titulo="Tabela de precos"
Texto extraido:
...
```

This is intentionally different from vector search. With one or two pages, full context is more reliable than hoping the correct chunk was retrieved.

### Source Logging

Every run should log:

- selected source IDs;
- title;
- category;
- score;
- reason, such as `category_match`, `title_match`, `keyword_match`;
- whether full text or snippet was used.

This allows debugging when an agent answers incorrectly.

## Provider Harness

The first real provider should be OpenAI-compatible, using the workspace settings.

Request:

- `POST {baseUrl}/chat/completions`
- `Authorization: Bearer {apiKey}`
- configured `model`
- JSON messages
- low-to-medium temperature for atendimento accuracy.

Recommended default:

- `temperature`: `0.2`
- output format: strict JSON parsed by Zod.

The provider output should keep the existing structure:

```ts
{
  confidence: number;
  reply?: string | null;
  actions: Array<Record<string, unknown>>;
  handoff: {
    required: boolean;
    reason: string | null;
  };
  sources?: Array<{
    id: string;
    title: string;
    category?: string;
  }>;
}
```

If the provider returns invalid JSON:

- retry once with a repair prompt or parse best-effort only if safe;
- if still invalid, log failed run;
- do not send an autonomous reply.

## Prompt Contract

The model must receive a firm contract:

- You are an atendimento agent for this workspace.
- Use the full conversation history.
- Use the selected documents when relevant.
- If asked about price, plan, conditions, policy, or contract, only answer if the selected documents contain the answer.
- Do not invent prices, deadlines, guarantees, legal terms, or policies.
- If the answer is missing or ambiguous, request human handoff.
- Keep replies concise and natural for WhatsApp.
- Return only valid JSON matching the schema.

## Safety And Handoff

The harness should request human handoff when:

- no relevant document is found for a document-dependent question;
- the relevant document does not contain the answer;
- the provider confidence is below threshold;
- the user is irritated, threatening, or asking for an exception;
- the model cannot produce valid structured output.

When handoff happens:

- do not send a confident business answer;
- optionally send a short message saying a human will continue;
- create an internal note with the reason if `create_internal_note` is allowed;
- set session status to `handoff_requested`;
- log selected documents and the reason.

## Architecture

Add or evolve these backend units:

- `provider-gateway.ts`
  - keep simulated provider;
  - add OpenAI-compatible provider;
  - add settings resolver.

- `conversation-context-builder.ts`
  - loads full message history;
  - formats history for the model.

- `knowledge-retrieval.ts`
  - classifies query intent;
  - scores knowledge sources;
  - returns selected documents and audit reasons.

- `knowledge-ingestion.ts`
  - extracts text from PDF uploads;
  - normalizes and stores metadata.

- `agent-runtime.ts`
  - uses conversation context builder;
  - uses knowledge retrieval;
  - calls real provider;
  - logs richer source metadata.

Frontend changes:

- Settings page for AI provider config.
- Agents page document upload/category UI.
- Agents page source list showing extraction status and categories.

## Testing Strategy

Backend tests:

- settings preserves/masks AI API key;
- OpenAI-compatible provider sends correct request and parses structured output;
- invalid provider output fails safely;
- PDF/text ingestion creates ready knowledge source with extracted content;
- retrieval selects `precos` document for price questions;
- retrieval avoids unrelated documents;
- runtime includes full conversation history;
- runtime sends a reply from provider output when confidence is sufficient;
- runtime requests handoff when no relevant document exists for a price question;
- human-controlled conversation still skips agent run.

Frontend tests:

- Settings renders AI provider form and redacted key behavior;
- Agents page can submit document source with category;
- Agents page lists uploaded document metadata.

Manual verification:

- Configure OpenAI-compatible provider.
- Add a short price PDF to `Secretaria IA`.
- Ask "quanto custa para 3 atendentes?"
- Confirm the agent uses the price document and conversation history.
- Ask an unrelated policy question with no policy document.
- Confirm the agent does not invent and requests handoff.
- Click `Assumir`.
- Confirm future inbound automation agent runs are skipped.

## Rollout

1. Keep simulated provider as fallback.
2. Add real provider behind workspace settings.
3. Seed demo can remain simulated unless local AI provider settings are configured.
4. Show clear UI state when provider is not configured.
5. Log failures rather than sending uncertain autonomous replies.

## Open Questions Deferred

- Whether to add embeddings later for larger libraries.
- Whether to add OCR for scanned PDFs.
- Whether to support per-agent provider overrides instead of workspace-level provider only.
- Whether to add a UI run inspector showing selected sources in detail.
