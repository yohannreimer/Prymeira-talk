# Villefer Conversational Continuity Design

**Date:** 2026-08-13

**Status:** Approved in conversation; awaiting review of this written specification.

## Context

A production Villefer dialogue showed that the agent receives enough context to continue the sale, but still sounds repetitive:

1. The customer asked about sheets.
2. The agent offered smooth or checker plate.
3. The customer chose smooth sheet.
4. The agent replied `Sim, a Villefer trabalha com chapas lisas` before asking for dimensions and thickness.

The runtime already loads up to 80 messages, orders them chronologically, and passes both a formatted transcript and structured messages to the provider. Existing runtime tests confirm that earlier customer and attendant turns are present. The failure is therefore not missing persistence.

The provider request currently serializes the transcript inside a JSON context carried by one user message. It also repeats the latest inbound message in `userPrompt`, `messageBody`, `conversationHistory`, and `conversationMessages`. The shared instruction only says to use the full history. This makes continuity weaker than a native multi-turn chat and does not explicitly prevent redundant confirmation.

## Goal

Make Villefer sound like a concise commercial team member who remembers what was just established and advances the sale naturally.

The approved identity is:

```text
Olá, tudo bem? Sou da equipe comercial da Villefer. Como posso te ajudar?
```

## Non-goals

- Do not build a rigid scripted chatbot or a general CRM sales-state engine.
- Do not invent prices, stock, deadlines, engineering conclusions, or commercial eligibility.
- Do not weaken the existing safety, knowledge retrieval, handoff, loop guard, media, or reply-timing behavior.
- Do not guarantee an exact sentence for every customer message; preserve natural variation within the contract.

## Design

### 1. Native conversation turns

The OpenAI-compatible provider request will translate usable runtime history into real chat roles:

- inbound customer message -> `user`;
- outbound message -> `assistant`;
- internal notes and system-only records -> excluded from the provider transcript.

The current inbound message will appear exactly once as the final user turn. Runtime context such as contact data, allowed actions, tags, and selected knowledge remains available as data, but `conversationHistory`, `conversationMessages`, and duplicate `messageBody` fields will not repeat the current customer text in the same request.

Image content remains attached to the final user turn. Audio transcription remains the final user text. If structured history is absent or invalid, the request falls back safely to the current user prompt.

### 2. Shared continuity contract

The provider's shared operational rules will require every agent to:

- interpret short answers using the immediately preceding question;
- treat facts and choices already established in the transcript as known state;
- never repeat a greeting or identity after the conversation has started;
- not restate or reconfirm a choice merely to acknowledge it;
- ask only for the next useful missing item;
- never ask again for information already supplied unless it is ambiguous or contradictory;
- use at most one question per reply by default;
- avoid automatic filler openings such as `Claro`, `Sim`, `Entendi` or `Perfeito` when they add no meaning;
- mention the company name only in the introduction or when needed for clarity.

These are behavioral rules, not factual overrides. Agent-specific identity, safety limits, and knowledge remain authoritative.

### 3. Villefer commercial behavior

The Villefer production system prompt will use the approved identity and this qualification order when the customer requests a quote or product information:

1. product or product family;
2. specification, dimensions, and thickness as applicable;
3. quantity;
4. delivery city when applicable.

The agent asks only for the next missing item. It may change the order when the customer's message makes another question more useful, but it must not request known data again.

Approved example:

```text
Cliente: Gostaria de saber mais informações sobre chapa.
Villefer: Trabalhamos com chapa lisa e chapa xadrez. Qual delas você procura?
Cliente: Pode ser chapa lisa.
Villefer: Qual medida e espessura você precisa?
```

Disallowed continuation:

```text
Sim, a Villefer trabalha com chapas lisas. Você já sabe a medida e a espessura que procura?
```

### 4. Safety and handoff

The existing deterministic safety policy remains before generation. Exact price, stock, deadline, structural sizing, unsupported commercial conditions, and explicit human requests keep their current handoff behavior. Conversation continuity must never turn an unsupported fact into a confirmed fact.

When the customer corrects prior information, the newest explicit statement wins. When two statements are genuinely ambiguous or contradictory, the agent asks one focused clarification rather than guessing.

## Verification

### Automated regression tests

- Provider requests contain chronological native `user` and `assistant` turns.
- The current inbound message appears exactly once.
- Internal notes are not exposed as dialogue turns.
- Image and audio final-turn behavior remains intact.
- Shared continuity rules are present in the provider system prompt.
- Existing history, safety, retrieval, action, handoff, loop-guard, media, and timing suites continue passing.

### Real-model multi-turn matrix

Run each case as a complete conversation, not as isolated prompts:

1. greeting -> broad sheet interest -> smooth sheet -> dimensions -> quantity -> city;
2. customer provides several qualification fields in one message;
3. short answers such as `lisa`, `3 mm`, `10 unidades`, and `Joinville`;
4. customer changes from smooth sheet to checker plate;
5. customer corrects a previously supplied dimension;
6. vague reply requiring one clarification;
7. interruption with an unrelated question, followed by return to the quote;
8. exact stock, price, and deadline requests;
9. structural sizing request;
10. explicit human request;
11. prompt injection and attempts to overwrite prior facts;
12. repeated messages and automated-loop scenarios;
13. image list and ambiguous image;
14. clear audio and audio with ambiguous numbers or units.

For every turn, record the exact input, exact reply, selected model, handoff state, relevant knowledge, reply length, and pass/fail reason. A dialogue fails if the agent repeats a greeting, restates a just-established choice without purpose, asks for known information, asks multiple unrelated questions, invents a protected fact, or loses the active product context.

### Production acceptance

After deployment, repeat the critical smooth-sheet dialogue through the real WhatsApp number. The expected third agent turn is a direct next qualification question, without `Sim`, without repeating that Villefer sells smooth sheet, and without a second introduction.

## Rollout and rollback

Release API and web images under one commit tag, then update the Villefer production prompt and verify persistence. Do not delete conversation data during rollout. Use the temporary owner-only reset only between independent test scenarios.

If native role mapping causes provider failures or materially worse behavior, restore the previous API image and previous Villefer prompt. Existing messages, contacts, media, and knowledge sources remain unchanged.
