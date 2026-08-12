# Villefer Exploratory Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Villefer discovery conversations useful without turning `pronta entrega` into a deadline handoff or asserting unsupported commercial and engineering conditions.

**Architecture:** Add one narrowly scoped deterministic exception for explanatory questions about the concept of `pronta entrega`, while preserving protection for actual stock and delivery commitments. Align the production Villefer system prompt with explicit commercial, engineering, and image-awareness boundaries; image bytes remain outside the provider request.

**Tech Stack:** TypeScript, Vitest, Fastify API, Prymeira Talk agent configuration, GPT-5.6 Luna, WhatsApp/Evolution.

---

## File structure

- Modify `apps/api/src/modules/agents/agent-safety-policy.ts`: distinguish conceptual `pronta entrega` questions from stock/deadline requests.
- Modify `apps/api/src/modules/agents/agent-safety-policy.test.ts`: lock conceptual and commitment cases with regression tests.
- Update the production `Agente Villefer` system prompt in Prymeira Talk: commercial eligibility, engineering/design, and image-input boundaries.
- Verify `docs/superpowers/specs/2026-08-12-villefer-exploratory-boundaries-design.md`: acceptance source for the production matrix.

### Task 1: Protect delivery commitments without blocking conceptual discovery

**Files:**
- Modify: `apps/api/src/modules/agents/agent-safety-policy.test.ts`
- Modify: `apps/api/src/modules/agents/agent-safety-policy.ts`

- [ ] **Step 1: Write failing regression tests**

Add tests that require ordinary model handling for conceptual questions and deterministic handoff for concrete commitments:

```ts
it.each([
  "Qual é a diferença entre pronta entrega e direto de fábrica?",
  "Como funciona a pronta entrega?",
  "O que significa pronta entrega?"
])("keeps conceptual ready-delivery questions exploratory: %s", (message) => {
  expect(evaluateAgentSafety({ message, selectedKnowledge: [] })).toEqual({
    handoffRequired: false,
    protectedFact: null,
    reason: null
  });
});

it.each([
  ["Tem chapa 3 mm pronta entrega?", "stock"],
  ["Consegue entregar amanhã?", "deadline"],
  ["Qual o prazo de entrega para Joinville?", "deadline"]
])("still protects concrete stock or delivery commitments: %s", (message, protectedFact) => {
  expect(evaluateAgentSafety({ message, selectedKnowledge: [] })).toEqual(
    expect.objectContaining({ handoffRequired: true, protectedFact })
  );
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- --run src/modules/agents/agent-safety-policy.test.ts
```

Expected: the conceptual `pronta entrega` cases fail because the current stock rule requests handoff.

- [ ] **Step 3: Implement the narrow conceptual exception**

Add a helper before protected-rule matching:

```ts
const READY_DELIVERY_CONCEPT = /\bpronta entrega\b/i;
const EXPLANATORY_QUESTION =
  /\b(o que (?:é|significa)|como funciona|qual (?:é )?a diferen[cç]a|diferen[cç]a entre)\b/i;

function isReadyDeliveryConceptQuestion(message: string) {
  return READY_DELIVERY_CONCEPT.test(message) && EXPLANATORY_QUESTION.test(message);
}
```

In `evaluateAgentSafety`, after the human-request check and before `PROTECTED_RULES.find`, return the ordinary non-handoff decision when `isReadyDeliveryConceptQuestion(input.message)` is true.

- [ ] **Step 4: Run the focused tests and confirm green**

Run the same focused test command. Expected: all `agent-safety-policy` tests pass.

- [ ] **Step 5: Commit the deterministic rule**

```bash
git add apps/api/src/modules/agents/agent-safety-policy.ts apps/api/src/modules/agents/agent-safety-policy.test.ts
git commit -m "fix: keep ready-delivery questions exploratory"
```

### Task 2: Align the Villefer production prompt

**Files:**
- Update through Prymeira Talk: `Agente Villefer` → `Prompt do sistema`

- [ ] **Step 1: Append the approved high-priority rules**

Add this exact block to the production system prompt:

```text
LIMITES COMERCIAIS: não confirme atendimento a pessoa física, venda no balcão, retirada, venda de uma única peça, quantidade mínima ou pedido mínimo sem evidência oficial. Diga que a condição precisa ser confirmada e, se útil, pergunte qual produto o cliente procura. "Pronta entrega" descreve uma modalidade; não significa estoque confirmado, quantidade disponível ou prazo prometido.

PROJETO E ENGENHARIA: se perguntarem se a Villefer projeta, dimensiona, calcula, aprova ou assume responsabilidade técnica por uma estrutura, responda diretamente que o assistente não realiza projeto de engenharia nem dimensionamento estrutural. Fotos, desenhos, medidas e listas podem ser analisados somente para avaliar o fornecimento e a viabilidade comercial, nunca para aprovar o projeto.

IMAGENS: você não recebe o conteúdo visual da imagem para análise. Nunca afirme que leu, identificou ou conferiu itens de uma foto. Se o cliente enviar uma lista em imagem, peça que envie os itens em texto ou diga que a equipe precisa analisar o arquivo. Uma legenda escrita pelo cliente pode ser usada normalmente.
```

- [ ] **Step 2: Save and verify the persisted prompt**

Reload the agent view and confirm that the three headings and exact rules remain in the `Prompt do sistema` field.

- [ ] **Step 3: Run the production simulator boundary matrix**

Test these isolated messages:

```text
Qual é a diferença entre pronta entrega e direto de fábrica?
Tem chapa 3 mm pronta entrega?
Vocês vendem para pessoa física ou só para empresa?
Consigo comprar só uma barra chata?
Vocês projetam uma estrutura para mim?
Se eu mandar uma imagem com uma lista, você consegue dizer se trabalham com tudo?
```

Expected:

- conceptual `pronta entrega`: explanation without handoff;
- concrete stock: fixed handoff acknowledgement;
- person/single unit: no unsupported confirmation;
- engineering: direct refusal of design/sizing plus supply-review option;
- image list: transparent limitation and request for text or team review.

- [ ] **Step 4: Commit the production-behavior evidence**

No secret or raw production data is added. Update the spec status to `Implemented and verified`, then commit:

```bash
git add docs/superpowers/specs/2026-08-12-villefer-exploratory-boundaries-design.md
git commit -m "docs: verify Villefer exploratory boundaries"
```

### Task 3: Full verification and rollout

**Files:**
- Verify the whole workspace; no additional source file is expected.

- [ ] **Step 1: Run all automated verification**

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: every command exits with status 0.

- [ ] **Step 2: Push the release branches**

```bash
git push origin codex/villefer-agent-hardening
git push origin HEAD:codex/prymeira-talk-foundation
```

- [ ] **Step 3: Wait for Docker publishing**

Use the GitHub Actions run triggered for `codex/prymeira-talk-foundation`. Expected: API and web image jobs complete successfully.

- [ ] **Step 4: Update only the Prymeira Talk API service**

Update `prymeiratalk_prymeira_talk_api` to the image tag for the new commit. Preserve environment variables, networks, volumes, replica count, resource limits, and the PostgreSQL service.

- [ ] **Step 5: Verify production health**

```bash
curl -fsS https://talk.prymeiradigital.com.br/api/health
curl -fsS https://talk.prymeiradigital.com.br/api/ready
```

Expected for both:

```json
{"ok":true,"product":"talk"}
```

- [ ] **Step 6: Repeat the six-case production matrix**

Run the Task 2 matrix again after deployment. Expected: all six outcomes match the approved behavior and no response exceeds 500 characters.

- [ ] **Step 7: Confirm a clean worktree**

```bash
git status --short
```

Expected: no output.
