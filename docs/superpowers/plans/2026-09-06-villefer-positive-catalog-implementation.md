# Villefer Positive Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o agente `Pré-atendimento Villefer — Teste` confirmar somente itens do catálogo positivo aprovado e recusar itens externos sem handoff.

**Architecture:** O pacote reutilizável recebe uma fonte de conhecimento exclusiva para o catálogo autorizado. O prompt continua genérico e passa a conter apenas a política determinística de aceitar, esclarecer ou recusar; a mesma configuração é replicada no agente de teste do Talk, sem alterar o agente Villefer ativo.

**Tech Stack:** Prymeira Talk, pacote JSON de agente, base de conhecimento textual e laboratório de teste do Talk.

---

## Estrutura dos arquivos

- Modify: `artifacts/agents/villefer/villefer-v1.agent-package.json` — política reutilizável e fonte positiva do catálogo.
- Reference: `docs/superpowers/specs/2026-09-06-villefer-positive-catalog-design.md` — comportamento aprovado.
- Verify: interface do agente `Pré-atendimento Villefer — Teste` — configuração e respostas reais do laboratório.

### Task 1: Atualizar o pacote reutilizável

- [ ] **Step 1: Acrescentar a política de catálogo ao prompt**

Incluir, antes dos limites comerciais, regras explícitas para: confirmação por correspondência, esclarecimento de termos ambíguos, recusa sem handoff e separação de pedidos mistos.

- [ ] **Step 2: Acrescentar a fonte `Catálogo positivo autorizado — Villefer V1`**

Registrar somente as categorias aprovadas na especificação. Marcar a fonte como confirmada e explicar que categoria autorizada não confirma estoque, medida, preço ou prazo.

- [ ] **Step 3: Validar o JSON**

Run: `jq empty artifacts/agents/villefer/villefer-v1.agent-package.json`

Expected: saída vazia e código zero.

- [ ] **Step 4: Confirmar que catálogo e política existem**

Run: `rg -n "CATÁLOGO POSITIVO|Catálogo positivo autorizado|plástico" artifacts/agents/villefer/villefer-v1.agent-package.json`

Expected: ocorrências no prompt e na nova fonte.

### Task 2: Aplicar somente no agente de teste

- [ ] **Step 1: Abrir `Pré-atendimento Villefer — Teste` e confirmar que está inativo**

Expected: o agente ativo `Agente Villefer` permanece sem alterações.

- [ ] **Step 2: Atualizar o prompt do agente de teste**

Inserir a política aprovada preservando a qualificação, os limites comerciais e o handoff existentes.

- [ ] **Step 3: Criar a fonte textual do catálogo**

Título: `Catálogo positivo autorizado — Villefer V1`.

Conteúdo: lista positiva e limites definidos na especificação.

- [ ] **Step 4: Salvar e conferir a persistência**

Expected: ao reabrir o agente, o bloco de política e a fonte continuam presentes.

### Task 3: Verificar o comportamento no laboratório

- [ ] **Step 1: Testar item externo**

Mensagem: `Vocês trabalham com plástico?`

Expected: negativa direta, uma pergunta de redirecionamento e nenhum handoff.

- [ ] **Step 2: Testar item permitido**

Mensagem: `Vocês trabalham com tubo quadrado?`

Expected: confirmação da categoria sem afirmar estoque, seguida de no máximo uma pergunta.

- [ ] **Step 3: Testar pedido misto**

Mensagem: `Preciso de chapa lisa e plástico.`

Expected: recusar plástico, manter chapa lisa e pedir no máximo um próximo dado relevante.

- [ ] **Step 4: Testar limite comercial**

Mensagem: `Tem 30 tubos quadrados disponíveis hoje?`

Expected: não confirmar estoque e encaminhar a confirmação conforme a regra comercial existente.

- [ ] **Step 5: Registrar os resultados e revisar regressões**

Expected: saudação, uma pergunta por mensagem, não repetição, qualificação e handoff continuam preservados.
