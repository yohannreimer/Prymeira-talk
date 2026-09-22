# Conversation Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recuperar conversas Villefer que esfriaram com no máximo três follow-ups contextuais, enviando automaticamente apenas a qualificação ainda sob controle do agente e exigindo revisão humana para proposta, negociação ou handoff.

**Architecture:** Um registro persistente por ciclo de conversa guarda a etapa, âncora, vencimento, decisão JEV, rascunho e resultado. Um scheduler independente da fila de resposta imediata trava itens vencidos, relê o histórico e usa JEV para decidir se ainda cabe contato. Um runtime dedicado gera e audita o texto com o agente; somente a rota automática entrega a mensagem. A rota humana produz um rascunho privado na aba Follow-ups. Toda atividade posterior invalida o ciclo anterior.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, Vitest, Zod, React, Vite, `@prymeira-talk/shared`, Evolution/Meta transports existentes e JEV/TypeSafe API.

---

## Decisões fixadas

- A cadência é calculada a partir da mensagem externa que deixou uma pendência: **6 horas úteis**, **2 dias úteis** e **4 dias úteis**, no calendário configurado pelo pacote do agente. Para Villefer: segunda a sexta, 08:00–18:00, `America/Sao_Paulo`.
- Há somente um item ativo por conversa. Os estados ativos são `scheduled`, `processing` e `review`; estados terminais liberam uma nova cadência.
- Uma mensagem inbound do cliente cancela o ciclo atual. Uma nova mensagem outbound relevante da empresa substitui o ciclo por uma nova âncora. O worker também faz essa verificação imediatamente antes de gerar, mostrar ou entregar qualquer texto.
- `agent_allowed` só pode entregar automaticamente follow-up de qualificação. `human_controlled`, proposta, negociação, exceção e handoff sempre acabam em `review`, nunca em envio automático.
- JEV decide necessidade, finalidade e rota; não é fonte de preço, estoque, frete, prazo, pagamento ou equivalência técnica. GPT/fornecedor do agente só redige a partir do prompt completo, da finalidade JEV e de fontes confirmadas; toda redação passa pela auditoria JEV já existente.
- Indisponibilidade de JEV, GPT ou transporte não degrada para envio cego: o item fica `failed` com erro auditável e pode ser reprocessado ou cancelado pelo operador.
- O recurso começa em conversas que tenham contexto de agente (sessão ativa ou última sessão do agente na conversa). Sem agente associado, nada é enviado automaticamente e nenhum rascunho é fabricado.

## Mapa de arquivos

| Área | Arquivos principais | Responsabilidade |
| --- | --- | --- |
| Banco e regras puras | `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/<timestamp>_conversation_followups/migration.sql`, `apps/api/src/modules/followups/business-time.ts` | Persistência, uma fila ativa por conversa e cálculo de horário útil. |
| Decisão e execução IA | `apps/api/src/modules/agents/jev-followup-decision.ts`, `apps/api/src/modules/agents/agent-followup-runtime.ts` | JEV estruturado, seleção de conhecimento, redação, auditoria e entrega segura. |
| Orquestração | `apps/api/src/modules/followups/conversation-followups.service.ts`, `apps/api/src/modules/followups/conversation-followup-scheduler.ts` | Criar/substituir/cancelar ciclos, travar itens, revalidar e avançar cadência. |
| Integrações API | `apps/api/src/app.ts`, `apps/api/src/modules/evolution/evolution.routes.ts`, `apps/api/src/modules/conversations/conversations.routes.ts`, `apps/api/src/modules/followups/conversation-followups.routes.ts` | Observar atividade, iniciar scheduler e expor fila/ações. |
| Contrato e UI | `packages/shared/src/realtime.ts`, `apps/web/src/app/api.ts`, `apps/web/src/features/followups/FollowupsPage.tsx`, `apps/web/src/features/followups/followup-display.ts`, `apps/web/src/features/followups/followups.css`, `apps/web/src/app/App.tsx`, `apps/web/src/features/shell/moduleRegistry.ts` | DTO, atualização em tempo real e aba operacional. |
| Configuração Villefer | `apps/api/src/modules/agents/villefer-v1-package.ts`, `apps/api/src/modules/agents/villefer-v1-definition.ts` | Primeiro intervalo de 360 minutos e conhecimento aprovado coerente. |

## Plano de implementação

### 1. Persistir ciclos de follow-up sem misturar com o debounce de resposta imediata

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_conversation_followups/migration.sql`
- Modify: `apps/api/src/modules/agents/villefer-v1-definition.test.ts`
- Create: `apps/api/src/modules/followups/conversation-followups.repository.test.ts`

- [ ] Escrever primeiro os testes de repositório para: criar um ciclo ativo, substituir o ciclo da mesma conversa, permitir histórico terminal e falhar ao tentar manter dois itens ativos.
- [ ] Acrescentar os enums `ConversationFollowupKind` (`qualification`, `human_commercial`) e `ConversationFollowupStatus` (`scheduled`, `processing`, `review`, `sent`, `cancelled`, `skipped`, `expired`, `failed`).
- [ ] Adicionar o model `ConversationFollowup` com, no mínimo:

  ```prisma
  id               String @id @default(uuid()) @db.Uuid
  workspaceId      String @map("workspace_id")
  conversationId   String @map("conversation_id") @db.Uuid
  agentId          String @map("agent_id") @db.Uuid
  sessionId        String? @map("session_id") @db.Uuid
  kind             ConversationFollowupKind
  status           ConversationFollowupStatus @default(scheduled)
  activeKey        String? @map("active_key")
  stepIndex        Int @map("step_index")
  anchorMessageId  String @map("anchor_message_id") @db.Uuid
  anchorMessageAt  DateTime @map("anchor_message_at")
  scheduledAt      DateTime @map("scheduled_at")
  lockedAt         DateTime? @map("locked_at")
  attempts         Int @default(0)
  decision         Json @default("{}")
  draftBody        String? @map("draft_body")
  finalBody        String? @map("final_body")
  reason           String? @map("reason")
  sentByUserId     String? @map("sent_by_user_id")
  sentAt           DateTime? @map("sent_at")
  cancelledAt      DateTime? @map("cancelled_at")
  cancelledByUserId String? @map("cancelled_by_user_id")
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  @@unique([workspaceId, id])
  @@unique([workspaceId, conversationId, activeKey])
  @@index([status, scheduledAt])
  @@index([workspaceId, conversationId, createdAt])
  ```

  Set `activeKey` to `"active"` only in `scheduled`, `processing` and `review`; clear it for every terminal status. This gives PostgreSQL a real single-active-cycle constraint while retaining the whole history.
- [ ] Add relations to `Conversation`, `AiAgent`, `AiAgentSession`, `Message` (anchor) and `User` (sender/canceller), following the workspace-scoped composite relations already used by `AiAgentPendingReply`.
- [ ] Generate the migration with the repository Prisma command, inspect its SQL for FK delete behavior and indexes, then regenerate the Prisma client. Do not hand-apply it to production.

Run:

```bash
pnpm --filter @prymeira-talk/api prisma migrate dev --name conversation_followups
pnpm --filter @prymeira-talk/api test -- conversation-followups.repository.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Commit:

```bash
git add apps/api/prisma apps/api/src/modules/followups/conversation-followups.repository.test.ts apps/api/src/modules/agents/villefer-v1-definition.test.ts
git commit -m "feat(followups): persist conversation followup cycles"
```

### 2. Calcular a cadência em tempo útil de forma determinística

**Files:**
- Create: `apps/api/src/modules/followups/business-time.ts`
- Create: `apps/api/src/modules/followups/business-time.test.ts`
- Modify: `apps/api/src/modules/agents/villefer-v1-package.ts`
- Modify: `apps/api/src/modules/agents/villefer-v1-definition.ts`
- Modify: `apps/api/src/modules/agents/villefer-v1-definition.test.ts`

- [ ] Escrever testes de tabela para `addBusinessMinutes` e `nextBusinessInstant`: dentro do expediente, depois das 18h, antes das 08h, sexta-feira, fim de semana e mudança de fuso `America/Sao_Paulo`.
- [ ] Implementar uma função pura, sem depender do relógio do processo:

  ```ts
  export function addBusinessMinutes(input: {
    from: Date;
    minutes: number;
    timeZone: string;
    businessDays: number[];
    businessHours: { start: string; end: string };
  }): Date
  ```

  Ela deve sempre retornar o próximo instante válido, inclusive quando a âncora ocorreu fora do horário útil. Usar `Intl.DateTimeFormat` e datas UTC normalizadas; não introduzir uma biblioteca de data sem necessidade.
- [ ] Alterar o primeiro `afterBusinessMinutes` Villefer de `720` para `360`; manter `1200` e `2400`.
- [ ] Atualizar a fonte confirmada `approved_followup_calendar` e os casos `followup_first` para falarem em seis horas úteis, eliminando o antigo “12 horas úteis”.
- [ ] Ajustar a expectativa de definição para `[360, 1200, 2400]` e manter a validação do calendário aprovado.

Run:

```bash
pnpm --filter @prymeira-talk/api test -- business-time.test.ts villefer-v1-definition.test.ts
```

Commit:

```bash
git add apps/api/src/modules/followups/business-time.ts apps/api/src/modules/followups/business-time.test.ts apps/api/src/modules/agents/villefer-v1-package.ts apps/api/src/modules/agents/villefer-v1-definition.ts apps/api/src/modules/agents/villefer-v1-definition.test.ts
git commit -m "feat(followups): apply Villefer business-hour cadence"
```

### 3. Criar a decisão JEV específica para follow-up

**Files:**
- Create: `apps/api/src/modules/agents/jev-followup-decision.ts`
- Create: `apps/api/src/modules/agents/jev-followup-decision.test.ts`
- Modify: `apps/api/src/modules/agents/jev-reply-preflight.ts` only if a shared TypeSafe request helper can be extracted without changing current behavior

- [ ] Escrever testes de contrato com `fetchImpl` simulado para respostas válidas, corpo inválido e timeout.
- [ ] Definir um contrato estrito, independente do preflight de resposta imediata:

  ```ts
  type FollowupDecision = {
    outcome: "follow_up" | "skip";
    purpose: "missing_qualification" | "proposal_checkin" | "objection_help" | "confirm_active" | "none";
    route: "automatic_send" | "human_review" | "cancel" | "wait";
    conversationStage: "qualification" | "post_proposal" | "seller_owned" | "closure" | "unclear";
    risk: "none" | "commercial" | "human_owned" | "unclear";
  };
  ```

- [ ] Formular perguntas JEV que recebam somente a janela de histórico, a etapa, a instrução da cadência e conhecimento selecionado. Proibir explicitamente tratar informação inferida como fato comercial.
- [ ] Aplicar guard rails após a resposta JEV: `automatic_send` só sobrevive se `kind === "qualification"`, conversa está `agent_allowed`, há sessão ativa compatível e não existe risco; todo outro caso é degradado para `human_review`, `wait` ou `cancel`.
- [ ] Testar pelo menos: agradecimento/resolução → `cancel`; dado técnico pendente sob agente → automático; proposta humana sem resposta → revisão; estoque/preço/prazo sem fonte → nunca automático; JEV indisponível → erro controlado, sem envio.

Run:

```bash
pnpm --filter @prymeira-talk/api test -- jev-followup-decision.test.ts jev-reply-preflight.test.ts
```

Commit:

```bash
git add apps/api/src/modules/agents/jev-followup-decision.ts apps/api/src/modules/agents/jev-followup-decision.test.ts apps/api/src/modules/agents/jev-reply-preflight.ts
git commit -m "feat(agents): add JEV followup decision"
```

### 4. Centralizar criação, invalidação e revalidação de ciclos

**Files:**
- Create: `apps/api/src/modules/followups/conversation-followups.service.ts`
- Create: `apps/api/src/modules/followups/conversation-followups.service.test.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.ts`
- Modify: `apps/api/src/modules/conversations/conversations.routes.ts`
- Modify: `apps/api/src/modules/evolution/evolution.routes.ts`

- [ ] Começar por testes que simulam as três direções de atividade:
  - inbound do cliente cancela o item ativo com `reason: "customer_replied"`;
  - outbound humano cria/substitui candidato `human_commercial` quando há última sessão de agente;
  - outbound do agente cria/substitui candidato `qualification`;
  - conversa encerrada, sem sessão de agente ou etapa acima de três não cria item;
  - duas chamadas concorrentes preservam um único `activeKey`.
- [ ] Expor no serviço uma única porta de entrada:

  ```ts
  observeConversationActivity({
    workspaceId, conversationId, messageId, direction,
    source: "customer" | "human" | "agent"
  }): Promise<{ status: "scheduled" | "cancelled" | "ignored"; followupId?: string }>;
  ```

  Para outbound, resolver a configuração do último `AiAgentSession` dessa conversa, classificar o candidato e calcular a primeira etapa. Para inbound, cancelar o registro ativo sem chamar IA.
- [ ] Expor `revalidateActiveFollowup` usado tanto pelo scheduler quanto pelas ações manuais. Ele consulta mensagens inbound/outbound posteriores à âncora, estado da conversa, canal e sessão; devolve um motivo terminal em vez de permitir usar um rascunho vencido.
- [ ] Ligar a observação ao webhook Evolution após salvar uma inbound, ao envio humano bem-sucedido de `/conversations/:conversationId/messages` e ao ponto único de criação de mensagem do runtime do agente. Não chamar o serviço antes do transporte confirmar e persistir a mensagem.
- [ ] Garantir que o follow-up nunca altere `aiControlStatus`, sessão ativa, responsável, tags ou status da conversa.

Run:

```bash
pnpm --filter @prymeira-talk/api test -- conversation-followups.service.test.ts evolution.routes.test.ts conversations.service.test.ts agent-runtime.test.ts
```

Commit:

```bash
git add apps/api/src/modules/followups/conversation-followups.service.ts apps/api/src/modules/followups/conversation-followups.service.test.ts apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/conversations/conversations.routes.ts apps/api/src/modules/evolution/evolution.routes.ts
git commit -m "feat(followups): schedule and invalidate conversation cycles"
```

### 5. Gerar, auditar e entregar follow-ups por um runtime separado

**Files:**
- Create: `apps/api/src/modules/agents/agent-followup-runtime.ts`
- Create: `apps/api/src/modules/agents/agent-followup-runtime.test.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.ts`
- Modify: `apps/api/src/modules/conversations/conversations.service.ts`

- [ ] Escrever testes para os quatro resultados: automático enviado, rascunho para revisão, auditoria JEV que bloqueia conteúdo comercial e falha de fornecedor/transporte que não cria mensagem externa.
- [ ] Extrair de `agent-runtime.ts` somente os helpers de leitura que já são reutilizáveis (`buildConversationContext`, seleção de conhecimento confirmado, normalização de saída e entrega de texto), preservando a semântica atual de resposta imediata.
- [ ] Criar `createAgentFollowupRuntime` que:
  1. monta o histórico completo permitido e fontes confirmadas relevantes;
  2. chama `JevFollowupDecision`;
  3. gera texto usando o prompt completo do agente + instrução da etapa + finalidade JEV;
  4. usa `AgentReplyPreflight.audit` no texto candidato;
  5. persiste `decision`, fontes usadas e resultado auditável.
- [ ] Para `automatic_send`, revalidar mais uma vez, usar a mesma entrega multicanal de `createConversationsService` e marcar `sent` só depois de persistir a mensagem externa. Para `human_review`, nunca tocar em transportes; persistir `draftBody`, `review` e a decisão.
- [ ] Depois de um envio automático, criar somente a próxima etapa com a mesma âncora do ciclo. Quando a etapa três for concluída, finalizar como `expired`/`sent` conforme o resultado e não agendar uma quarta tentativa.
- [ ] Mantendo o scope aprovado, se o contexto completo ultrapassar os limites de raciocínio, levar o item a `review` com o motivo “histórico requer revisão”, em vez de reduzir silenciosamente o histórico e enviar algo inseguro.

Run:

```bash
pnpm --filter @prymeira-talk/api test -- agent-followup-runtime.test.ts agent-runtime.test.ts conversation-context-builder.test.ts
```

Commit:

```bash
git add apps/api/src/modules/agents/agent-followup-runtime.ts apps/api/src/modules/agents/agent-followup-runtime.test.ts apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/conversations/conversations.service.ts
git commit -m "feat(followups): generate and audit contextual followups"
```

### 6. Processar vencimentos com lock, lote e recuperação segura

**Files:**
- Create: `apps/api/src/modules/followups/conversation-followup-scheduler.ts`
- Create: `apps/api/src/modules/followups/conversation-followup-scheduler.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] Modelar os testes a partir de `agent-reply-scheduler.test.ts`: somente itens `scheduled` vencidos entram no lote, um lock torna a segunda execução inócua, e o lock sempre é liberado em sucesso e erro.
- [ ] Implementar `createConversationFollowupScheduler` com `processDueFollowups`, `start` e `stop`, intervalo de polling configurável e `batchSize` limitado. O worker deve usar atualização condicional `status: scheduled` → `processing` com `lockedAt`, não apenas um `findMany` seguido de `update` sem guarda.
- [ ] Para cada item: revalidar, decidir com JEV, gerar/auditar no runtime, gravar estado terminal ou próxima etapa e publicar uma atualização. Erros inesperados devem permanecer `failed` com `lastError`, sem retries que possam duplicar envio.
- [ ] Registrar o scheduler em `app.ts` com o mesmo ciclo de `onClose` da fila de resposta imediata. Injetar o mesmo provider, preflight JEV, Evolution runtime, Meta runtime e realtime hub necessários ao runtime de follow-up.
- [ ] Incluir teste de integração leve para a inicialização com `JEV_API_KEY` ausente: a API sobe, mas o scheduler não faz entrega autônoma.

Run:

```bash
pnpm --filter @prymeira-talk/api test -- conversation-followup-scheduler.test.ts app.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Commit:

```bash
git add apps/api/src/modules/followups/conversation-followup-scheduler.ts apps/api/src/modules/followups/conversation-followup-scheduler.test.ts apps/api/src/app.ts
git commit -m "feat(followups): process due conversation followups"
```

### 7. Expor fila e ações humanas com revalidação no servidor

**Files:**
- Create: `apps/api/src/modules/followups/conversation-followups.routes.ts`
- Create: `apps/api/src/modules/followups/conversation-followups.routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `packages/shared/src/realtime.ts`
- Modify: `packages/shared/src/domain.test.ts`

- [ ] Proteger listagem e ações com a permissão já existente `conversation.read`/`conversation.reply`; não criar uma nova permissão de automação, pois os vendedores precisam revisar a própria fila.
- [ ] Implementar estes contratos:

  ```text
  GET  /followups?status=review|scheduled|sent|cancelled
  POST /followups/:id/send       { body, expectedUpdatedAt }
  POST /followups/:id/postpone   { expectedUpdatedAt }
  POST /followups/:id/cancel     { reason, expectedUpdatedAt }
  POST /followups/:id/no-followup { expectedUpdatedAt }
  ```

  Ação de enviar aceita texto editado (1–4000 caracteres), revalida em transação lógica antes do transporte, grava `sentByUserId` e manda como mensagem humana. `postpone` move para o próximo horário útil previsto, sem adicionar uma etapa. Versão divergente retorna `409 FOLLOWUP_STALE` com o DTO atual.
- [ ] Criar `conversation_followup.updated` no contrato de realtime com payload serializado que não exponha conhecimento bruto, prompts ou logs do fornecedor. Publicar a mudança após todo agendamento, cancelamento, falha, criação de rascunho e envio.
- [ ] Testar isolamento de workspace, vendedor sem `conversation.reply`, edição válida, item tornado obsoleto por resposta do cliente, e dupla confirmação de envio.

Run:

```bash
pnpm --filter @prymeira-talk/api test -- conversation-followups.routes.test.ts
pnpm --filter @prymeira-talk/shared test -- domain.test.ts
```

Commit:

```bash
git add apps/api/src/modules/followups/conversation-followups.routes.ts apps/api/src/modules/followups/conversation-followups.routes.test.ts apps/api/src/app.ts packages/shared/src/realtime.ts packages/shared/src/domain.test.ts
git commit -m "feat(followups): expose review queue actions"
```

### 8. Construir a aba Follow-ups no Talk

**Files:**
- Modify: `apps/web/src/app/api.ts`
- Create: `apps/web/src/features/followups/FollowupsPage.tsx`
- Create: `apps/web/src/features/followups/FollowupsPage.test.tsx`
- Create: `apps/web/src/features/followups/followup-display.ts`
- Create: `apps/web/src/features/followups/followup-display.test.ts`
- Create: `apps/web/src/features/followups/followups.css`
- Modify: `apps/web/src/features/shell/moduleRegistry.ts`
- Modify: `apps/web/src/app/App.tsx`

- [ ] Adicionar em `api.ts` o DTO de follow-up e funções `apiListFollowups`, `apiSendFollowup`, `apiPostponeFollowup`, `apiCancelFollowup` e `apiMarkFollowupNoFollowup`, com parser de resposta e propagação de `409` para a interface.
- [ ] Adicionar o módulo `followups` logo após Atendimento, com rótulo “Follow-ups” e ícone de acompanhamento; renderizar `FollowupsPage` em `App.tsx`.
- [ ] Construir quatro filtros: **Para revisar**, **Agendados**, **Enviados** e **Cancelados**. Cada card mostra contato, última mensagem/âncora, tipo, etapa, horário, finalidade, motivo, texto final ou rascunho e status.
- [ ] Para `review`, disponibilizar “Enviar”, “Editar e enviar”, “Adiar”, “Cancelar” e “Não acompanhar”. Desabilitar ações em andamento e, ao receber `FOLLOWUP_STALE`, atualizar o card, informar que o contexto mudou e não reenviar automaticamente.
- [ ] Para `scheduled`, mostrar a data local e opção de cancelar. Para `sent` e `cancelled`, manter linha do tempo legível, sem botões de envio.
- [ ] Assinar `useRealtimeEvents` e recarregar/conciliar o item ao receber `conversation_followup.updated`, `message.created` ou `conversation.updated`. A aba não pode depender de refresh manual para retirar uma sugestão invalidada.
- [ ] Isolar os estilos em `followups.css`, evitando tocar em `apps/web/src/styles.css`, que possui alterações de trabalho não relacionadas.
- [ ] Cobrir em testes: filtro inicial de revisão, rascunho editável, ação enviada com texto editado, cancelamento, estado obsoleto e atualização em tempo real.

Run:

```bash
pnpm --filter @prymeira-talk/web test -- FollowupsPage.test.tsx followup-display.test.ts
pnpm --filter @prymeira-talk/web typecheck
```

Commit:

```bash
git add apps/web/src/app/api.ts apps/web/src/features/followups apps/web/src/features/shell/moduleRegistry.ts apps/web/src/app/App.tsx
git commit -m "feat(web): add followup review queue"
```

### 9. Verificação integrada e ensaio controlado antes de produção

**Files:**
- Modify: `apps/api/scripts/test-jev-villefer-package-live.ts`
- Create: `apps/api/scripts/test-followups-villefer-live.ts`
- Modify: `apps/api/package.json`
- Modify: `docs/superpowers/specs/2026-09-21-conversation-followups-design.md` only if implementation exposes a deliberate, approved deviation

- [ ] Estender o harness de JEV para registrar a decisão de follow-up usando o pacote Villefer real e somente conhecimento aprovado. Nunca colocar chaves, números reais, nomes de contatos ou conteúdo de produção em fixtures/commits.
- [ ] Criar um ensaio sem transporte externo que execute as decisões abaixo em banco/serviços simulados e apresente: decisão JEV, rota, rascunho/auditoria e estado final.
  - qualificação parada por medida/espessura → automático elegível;
  - proposta humana aguardando resposta → rascunho de revisão;
  - cliente respondeu antes de 6 horas úteis → cancelado;
  - vendedor respondeu depois da sugestão → rascunho obsoleto/cancelado;
  - handoff durante a espera → sem autoenvio;
  - texto com preço, estoque, prazo, frete ou equivalência sem fonte → bloqueado;
  - terceiro envio → nenhuma quarta etapa.
- [ ] Executar a suíte afetada completa, `typecheck` de todos os workspaces e a migração contra banco de desenvolvimento. Inspecionar `git diff --check`, `git status --short` e manter fora dos commits os arquivos não relacionados já existentes no worktree.
- [ ] Fazer a primeira ativação em ambiente de teste com transportes desabilitados e JEV habilitado; validar a aba com dados sintéticos antes de qualquer deploy que permita envio.

Run:

```bash
pnpm --filter @prymeira-talk/api test:followups-villefer-live
pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/api typecheck
pnpm --filter @prymeira-talk/web test
pnpm --filter @prymeira-talk/web typecheck
git diff --check
git status --short
```

Commit:

```bash
git add apps/api/scripts/test-jev-villefer-package-live.ts apps/api/scripts/test-followups-villefer-live.ts apps/api/package.json
git commit -m "test(followups): add Villefer followup verification"
```

## Final acceptance checklist

- [ ] Uma mensagem de cliente torna o follow-up anterior impossível de enviar tanto pelo worker quanto pela ação manual.
- [ ] Nenhuma conversa `human_controlled` recebe uma mensagem automática; proposta e negociação aparecem como rascunho para revisão.
- [ ] A etapa um Villefer vence após seis horas úteis; as etapas dois e três continuam em dois e quatro dias úteis.
- [ ] JEV não é usado como fonte de fato comercial e a auditoria bloqueia textos inseguros.
- [ ] Um item não pode ser enviado duas vezes sob polling concorrente, clique repetido ou atualização em tempo real atrasada.
- [ ] A aba exibe revisão, agendamento, envio e cancelamento sem expor prompt, fonte completa ou segredo.
- [ ] Testes automatizados, ensaio Villefer sem transporte e typechecks passam antes de considerar deploy.
