# Junior Context and PDF Implementation Plan

> **For agentic workers:** Use inline execution with regression checks for each task.

**Goal:** Confirm context-dependent choices and retry unreadable customer PDFs once before a real human handoff.

**Architecture:** Add opt-in per-agent attendance rules to the existing model context. Add an opt-in document recovery policy in the media runtime, retaining existing extraction limits, message records, caches and handoff guards.

**Tech Stack:** TypeScript, Prisma runtime, Vitest, pnpm.

---

### Task 1: Agent-scoped attendance configuration

Files: `apps/api/src/modules/harness/agentes/atendimento/producao.ts`, `apps/api/src/modules/harness/harness.test.ts`.

- [x] Add failing tests for parsing `regrasDoAtendimento: string[]` and `recuperacaoDeAnexos: "reler_e_repassar"`, rejecting unsupported policy values.
- [x] Verify failure with `pnpm --filter @prymeira-talk/api test -- src/modules/harness/harness.test.ts`.
- [x] Parse only valid rules/policy; forward attendance rules as `pedido.regrasDaEmpresa`, which is rendered to reader and writer. Keep follow-up rules separate.
- [x] Rerun the same tests.

### Task 2: Retry and human handoff

Files: `apps/api/src/modules/agents/agent-runtime.ts`, `apps/api/src/modules/agents/agent-runtime.test.ts`.

- [x] Add failing tests for a current PDF and a PDF followed by text: first failure then success; two failures then handoff without a customer resend request; successful cached result; disabled and other-channel policy.
- [x] Verify failure with `pnpm --filter @prymeira-talk/api test -- src/modules/agents/agent-runtime.test.ts`.
- [x] Read the attendance policy before media preparation. For an enabled document only, call the existing preparer again on failure, at most twice in this run. Preserve extraction limits and original attachment. Replace the final fallback with an internal human-review note and force the existing handoff path. Preserve any prior burst handoff requirement.
- [x] Rerun the tests and relevant inbound-media tests; run `pnpm --filter @prymeira-talk/api typecheck`.

### Task 3: Reviewable activation instructions

- [x] Document the exact Junior config additions and expected customer messages, without changing production.
- [x] Review diff and requirements; save a factual local second-brain report. Report deployment status accurately.

### Extensão aprovada durante a execução

- [x] Reproduzir os erros de inspeção nos PDFs duráveis: três arquivos com inventário válido e aviso de coleção AutoCAD.
- [x] Encaminhar somente esse aviso à visão e evitar a extração nativa nesse caminho; manter as demais rejeições.
- [x] Reproduzir e corrigir o cache ignorado no anexo atual, validando hash antes de reutilizar.
- [x] Distinguir categorias HTTP do provedor visual e incluir a segunda tentativa para imagens na política opt-in.
- [x] Executar 269 testes relevantes, typecheck e build de produção da API.
- [ ] Publicar imagem validada e ativar somente no Junior; confirmar saúde e configuração observadas.
