# Triagem humana do Atendimento Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar à equipe filtros globais de não lidas, marcações manuais e respostas pendentes por contexto, sem perder os repasses existentes nem conversas antigas.

**Architecture:** Um registro persistente de triagem por conversa guarda a marca manual, a decisão semântica, a mensagem âncora, a dispensa e a próxima análise. Um observador registra entradas/saídas e um worker com lease processa a última entrada após dois minutos de silêncio; a API consulta os filtros no banco com paginação. A interface mantém as abas atuais, acrescenta três ícones Lucide e atualiza os cards por eventos existentes.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, Zod, React, Lucide, Vitest, WebSocket existente.

---

## Referências e mapa de arquivos

- Spec aprovada: `docs/superpowers/specs/2026-09-25-inbox-human-triage-design.md`.
- Criar `apps/api/src/modules/conversations/inbox-triage-policy.ts`: regras puras e contexto do classificador.
- Criar `apps/api/src/modules/conversations/inbox-triage-model.ts`: adaptadores Luna/JEV, resposta estruturada e fallback.
- Criar `apps/api/src/modules/conversations/inbox-triage.service.ts`: estado persistente, marcação, dispensa, observação de mensagens e fencing.
- Criar `apps/api/src/modules/conversations/inbox-triage-scheduler.ts`: polling, lease, recuperação e backfill.
- Criar `apps/api/src/modules/conversations/inbox-triage.routes.ts`: ações manuais; o GET da lista continua em `conversations.routes.ts`.
- Modificar `apps/api/prisma/schema.prisma` e criar `apps/api/prisma/migrations/20260925180000_inbox_human_triage/migration.sql`.
- Modificar `packages/shared/src/domain.ts`, `apps/api/src/modules/conversations/conversations.service.ts`, `conversations.routes.ts`, `apps/api/src/app.ts`, as rotas de mensagem Evolution/Meta/Talk e o runtime de saída do agente.
- Modificar `apps/web/src/app/api.ts`, `apps/web/src/features/inbox/InboxPage.tsx`, `apps/web/src/features/inbox/conversation-display.ts` e `apps/web/src/styles.css`. Se o card exigir muita lógica no `InboxPage`, criar `apps/web/src/features/inbox/InboxQuickFilters.tsx` e `InboxConversationCard.tsx` para isolá-la.
- Criar testes com o mesmo nome-base dos módulos novos e ampliar os testes existentes de listagem, webhooks e Inbox.

**Invariantes:** nenhuma ação desta entrega envia WhatsApp; `Próxima ação` continua sendo repasse explícito; resultado de modelo antigo nunca substitui a última conversa; a marca manual sobrevive à resposta; uma dispensa vale apenas para sua mensagem âncora e para todos do número.

### Task 1: Persistência e contrato público

**Files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260925180000_inbox_human_triage/migration.sql`, `packages/shared/src/domain.ts`, `apps/api/src/modules/conversations/conversations.service.ts`, `apps/api/src/modules/conversations/conversations.service.test.ts`.

- [ ] **Step 1: Escrever o teste que falha.** Em `conversations.service.test.ts`, criar um registro com `inboxTriage.manualMarkedAt`, `decision`, `reason` e `anchorMessageId` e esperar `toConversationDto()` expor `manualMarked: true`, `replyTriageDecision`, `replyTriageReason`, `replyTriageAnchorMessageId` e `replyDismissed: false`. Outro caso sem relação deve devolver `false/null`.
- [ ] **Step 2: Confirmar falha.** Run: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/conversations/conversations.service.test.ts`. Expected: FAIL nos novos campos ausentes.
- [ ] **Step 3: Adicionar enum, relação e migration.** Usar estes campos no Prisma; a migration deve criar a tabela e índices equivalentes, com FK composta e `ON DELETE CASCADE`:

```prisma
enum InboxReplyDecision {
  needs_reply
  no_reply
  uncertain
}

model ConversationInboxTriage {
  id                 String              @id @default(uuid()) @db.Uuid
  workspaceId        String              @map("workspace_id")
  conversationId     String              @map("conversation_id") @db.Uuid
  manualMarkedAt     DateTime?           @map("manual_marked_at")
  manualMarkedById   String?             @map("manual_marked_by_id") @db.Uuid
  lastObservedMessageId String?           @map("last_observed_message_id") @db.Uuid
  anchorMessageId    String?             @map("anchor_message_id") @db.Uuid
  decision           InboxReplyDecision?
  reason             String?
  model              String?
  analyzedAt         DateTime?           @map("analyzed_at")
  dismissedMessageId String?             @map("dismissed_message_id") @db.Uuid
  dismissedAt        DateTime?           @map("dismissed_at")
  dueAt              DateTime?           @map("due_at")
  lockToken          String?             @map("lock_token") @db.Uuid
  lockedAt           DateTime?           @map("locked_at")
  version            Int                 @default(0)
  createdAt          DateTime            @default(now()) @map("created_at")
  updatedAt          DateTime            @updatedAt @map("updated_at")
  conversation       Conversation        @relation(fields: [workspaceId, conversationId], references: [workspaceId, id], onDelete: Cascade)

  @@unique([workspaceId, conversationId])
  @@index([dueAt, lockedAt])
  @@index([workspaceId, manualMarkedAt])
  @@index([workspaceId, decision])
  @@map("conversation_inbox_triage")
}
```

Adicionar `inboxTriage ConversationInboxTriage?` em `Conversation`. Criar a migration no caminho indicado com `CREATE TYPE "InboxReplyDecision" AS ENUM ('needs_reply','no_reply','uncertain')`, `CREATE TABLE "conversation_inbox_triage"` contendo as colunas mapeadas acima (`id UUID`, `workspace_id TEXT`, `conversation_id UUID`, timestamps `TIMESTAMP(3)`, `version INTEGER NOT NULL DEFAULT 0`), índices para `due_at/locked_at`, `workspace_id/manual_marked_at`, `workspace_id/decision`, chave única `(workspace_id, conversation_id)` e FK `(workspace_id, conversation_id)` para `conversations(workspace_id,id) ON DELETE CASCADE`. Comparar o SQL gerado por `prisma migrate diff` em banco local de desenvolvimento para detectar divergência; nunca executar `migrate dev` contra produção.
- [ ] **Step 4: Ampliar DTO e mapper.** Em `conversationSchema`, adicionar campos Zod com defaults compatíveis com registros legados:

```ts
manualMarked: z.boolean().default(false),
replyTriageDecision: z.enum(["needs_reply", "no_reply", "uncertain"]).nullable().default(null),
replyTriageReason: z.string().nullable().default(null),
replyTriageAnchorMessageId: z.string().nullable().default(null),
replyDismissed: z.boolean().default(false)
```

Exportar também `inboxViewSchema = z.enum(["all", "unread", "marked", "reply", "handoff"])` e `InboxView = z.infer<typeof inboxViewSchema>` de `packages/shared/src/domain.ts` para API e web usarem os mesmos valores.

Adicionar `inboxTriage` ao `conversationDtoInclude`, a `ConversationRecord` e ao retorno de `toConversationDto()`. Derivar `replyDismissed` comparando `dismissedMessageId === anchorMessageId`, com ambos não nulos. Usar defaults `false/null` quando a relação não existir.
- [ ] **Step 5: Validar e commitar.** Run: `pnpm --filter @prymeira-talk/api exec prisma validate --schema prisma/schema.prisma`, `pnpm --filter @prymeira-talk/api exec prisma generate --schema prisma/schema.prisma`, `pnpm --filter @prymeira-talk/api exec vitest run src/modules/conversations/conversations.service.test.ts`, `pnpm --filter @prymeira-talk/api typecheck`. Expected: todos PASS. Commit: `feat(talk): persist inbox triage state`.

### Task 2: Regras puras de fila e contexto

**Files:** criar `apps/api/src/modules/conversations/inbox-triage-policy.ts` e `.test.ts`.

- [ ] **Step 1: Escrever testes que falham** para: IA ativa sem repasse fora de **Não lidas**; humano com `unreadCount > 0` dentro; repasse pendente dentro de **Não lidas** e **Responder**; agradecimento de encerramento fora de **Responder** após decisão `no_reply`; `uncertain` dentro com **Revisar**; marca manual independente; dispensa da âncora fora de **Responder**.
- [ ] **Step 2: Confirmar falha.** Run: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/conversations/inbox-triage-policy.test.ts`. Expected: FAIL porque as funções não existem.
- [ ] **Step 3: Implementar funções puras com assinaturas fixas:**

```ts
export type TriageDecision = "needs_reply" | "no_reply" | "uncertain";
export type TriageMessage = {
  id: string; direction: "inbound" | "outbound";
  author: "cliente" | "empresa_humano" | "empresa_ia";
  type: string; body: string | null; createdAt: string;
};

export function hasPendingHandoff(c: {
  status: string; aiControlStatus: string;
  activeAgentSessionStatus?: string | null;
  handoffReason?: string | null; handoffActionCompletedAt?: string | null;
}) {
  return c.status !== "closed" && !c.handoffActionCompletedAt &&
    (c.activeAgentSessionStatus === "handoff_requested" ||
      (c.aiControlStatus === "human_controlled" && Boolean(c.handoffReason)));
}

export function shouldShowReply(c: {
  aiControlStatus: string; pendingHandoff: boolean;
  decision: TriageDecision | null; dismissed: boolean;
}) {
  return c.pendingHandoff || (c.aiControlStatus === "human_controlled" &&
    !c.dismissed && (c.decision === "needs_reply" || c.decision === "uncertain"));
}
```

`shouldShowUnread` usa `unreadCount > 0 && (human_controlled || pendingHandoff)`. `formatTriageContext(messages)` usa as últimas 20 mensagens relevantes, limita cada texto a 2.000 caracteres, mantém tipo/hora/autor, remove notas internas e reservas de follow-up, e registra anexo sem texto como `conteúdo indisponível`.
- [ ] **Step 4: Testar e commitar.** Run: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/conversations/inbox-triage-policy.test.ts`. Expected: PASS. Commit: `feat(talk): define inbox triage policy`.

### Task 3: Marca, dispensa e observação durável

**Files:** criar `apps/api/src/modules/conversations/inbox-triage.service.ts` e `.test.ts`.

- [ ] **Step 1: Escrever testes que falham** para marca compartilhada, remoção só manual, dispensa condicionada à âncora, desfazer em até dez segundos, nova entrada limpando dispensa e reiniciando `dueAt`, saída limpando decisão sem apagar marca, e observação repetida do mesmo ID sem incrementar `version`.
- [ ] **Step 2: Confirmar falha.** Run: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/conversations/inbox-triage.service.test.ts`. Expected: FAIL nas operações inexistentes.
- [ ] **Step 3: Criar a interface do serviço e implementar as escritas transacionais:**

```ts
export type InboxTriageObserver = {
  observeMessage(input: {
    workspaceId: string; conversationId: string; messageId: string;
    direction: "inbound" | "outbound"; observedAt: Date;
  }): Promise<void>;
};

export function nextInboxAnalysisAt(observedAt: Date) {
  return new Date(observedAt.getTime() + 120_000);
}
```

`observeMessage(inbound)` faz `upsert` por `(workspaceId, conversationId)` e, se o ID for novo, grava `lastObservedMessageId`, `anchorMessageId`, `decision/reason/model/analyzedAt/dismissedMessageId/dismissedAt=null`, `lockToken/lockedAt=null` e `version += 1`. Se a conversa já está sob controle humano, grava `dueAt=nextInboxAnalysisAt(observedAt)`; se a IA a atende sem repasse, grava `dueAt=null`. `observeMessage(outbound)` grava `lastObservedMessageId` e limpa a pendência semântica e o prazo, preservando `manualMarkedAt`, também sob comparação de mensagem para não apagar uma entrada posterior. Usar a ordem real `createdAt, id` das mensagens para verificar qual é a última; usar `observedAt` do servidor para contar os dois minutos, não um timestamp atrasado do provedor. Em conflito de escrita, reler e repetir uma vez sob transação.
- [ ] **Step 4: Implementar ações com guarda explícita.** `setManualMark({workspaceId, conversationId, actorId, marked})` faz upsert/update e devolve DTO atualizado. `dismiss({workspaceId, conversationId, expectedAnchorMessageId})` usa `updateMany` com a âncora e decisão atuais, gravando `dismissedMessageId` e `dismissedAt`. `undoDismiss` exige a mesma âncora e `dismissedAt` dentro dos dez segundos anteriores. Se a versão mudou, retornar 409 em vez de dispensar a próxima mensagem.
- [ ] **Step 5: Testar e commitar.** Run: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/conversations/inbox-triage.service.test.ts` e `pnpm --filter @prymeira-talk/api typecheck`. Expected: PASS. Commit: `feat(talk): save shared inbox actions and activity`.

### Task 4: Classificadores estruturados e avaliação comparativa

**Files:** criar `apps/api/src/modules/conversations/inbox-triage-model.ts`, `.test.ts`, `apps/api/scripts/evaluate-inbox-triage.ts`; modificar `apps/api/src/env.ts` e `apps/api/src/env.test.ts`; usar `apps/api/src/modules/agents/luna-structured-analysis.ts` e o protocolo de `apps/api/src/modules/followups/jev-followup-eligibility.ts`.

- [ ] **Step 1: Escrever testes que falham** com histórico cliente/empresa: pedido sem resposta → `needs_reply`; “ok, obrigada” após resolução → `no_reply`; “boa noite” no início e no fim com decisões distintas; anexo sem transcrição → `uncertain`; histórico injetando instrução → ignorar instrução; erro Luna → JEV; ambos indisponíveis → `uncertain`.
- [ ] **Step 2: Confirmar falha.** Run: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/conversations/inbox-triage-model.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implementar contrato e Luna.**

```ts
const resultSchema = z.object({
  decision: z.enum(["needs_reply", "no_reply", "uncertain"]),
  reason: z.string().min(1).max(240)
});
export type InboxTriageResult = z.infer<typeof resultSchema> & { model: string };
export type InboxTriageClassifier = {
  assess(input: { workspaceId: string; anchorMessageId: string; messages: TriageMessage[] }):
    Promise<InboxTriageResult>;
};
```

O prompt manda analisar quem tem a próxima ação, com exemplos positivos e negativos do spec, e trata o histórico como dados. `createLunaStructuredAnalysis({prisma})` recebe `formatTriageContext(messages)` e `resultSchema`. Exigir `anchorMessageId` entre as mensagens e última mensagem útil de entrada; do contrário não classificar como pendente.
- [ ] **Step 4: Implementar JEV e seleção.** O adaptador JEV usa `POST https://api.typesafe.ai/v1/systemone`, timeout de 12 s, `questions.decision` com escolhas `needs_reply/no_reply/uncertain` e `questions.reason` com categorias fechadas que são mapeadas a texto curto. Validar a resposta com Zod. Acrescentar `INBOX_TRIAGE_PRIMARY: z.enum(["luna","jev"]).default("luna")` em `env.ts` e teste de parse em `env.test.ts`; passar a escolha em `app.ts` ao criar o classificador. O seletor tenta o primário e depois o secundário configurado; se ambos falharem, devolve `{decision:"uncertain",reason:"Análise indisponível; revisar conversa",model:"fallback"}`. Não chamar um modelo se o último evento já é saída.
- [ ] **Step 5: Criar avaliação reproduzível.** `evaluate-inbox-triage.ts` lê arquivo local JSONL indicado por `INBOX_TRIAGE_EVAL_FILE`, com `{caseId, expected, messages}` sem salvar dados brutos no Git; executa os dois adaptadores, imprime totais de perdas de `needs_reply`, falsos alertas, latência p50/p95 e diferenças por caso. Exigir pelo menos 50 casos rotulados antes de escolher configuração de produção. Testar e commitar: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/conversations/inbox-triage-model.test.ts`; expected PASS. Commit: `feat(talk): classify reply needs with Luna and JEV`.

### Task 5: Worker com debounce, lease e backfill

**Files:** criar `apps/api/src/modules/conversations/inbox-triage-scheduler.ts` e `.test.ts`; modificar `apps/api/src/app.ts`.

- [ ] **Step 1: Escrever testes que falham** para três entradas espaçadas um minuto → um processamento dois minutos após a última; dois workers → um claim; entrada durante a chamada ao modelo → resultado antigo rejeitado; reinício → item devido encontrado; lease expirado → retry; saída durante análise → sem pendência; repasse visível sem esperar worker.
- [ ] **Step 2: Confirmar falha.** Run: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/conversations/inbox-triage-scheduler.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implementar polling e claim atômico.** A cada 5 s, buscar até 20 registros com `dueAt <= now` e `lockToken=null`. Para cada candidato, fazer o claim abaixo; só `count===1` chama o modelo:

```ts
const token = randomUUID();
const claim = await prisma.conversationInboxTriage.updateMany({
  where: { id: candidate.id, version: candidate.version, lockToken: null, dueAt: { lte: now } },
  data: { lockToken: token, lockedAt: now }
});
if (claim.count !== 1) return;
```

Antes de gravar, buscar a última mensagem visível e validar `(id,version,anchorMessageId,lockToken)`, controle humano e ausência de saída posterior. Gravar por `updateMany` com esses mesmos campos no `where`; se `count===0`, descartar o resultado sem publicá-lo. Limpar lease e prazo na gravação. `stop()` espera poll ativo antes de fechar Prisma, como o scheduler de follow-ups.
- [ ] **Step 4: Recuperação e backfill.** Limpar leases com `lockedAt < now-60s`. A cada poll, reconciliar primeiro mensagens recém-ingeridas em páginas pela dupla `(ingestedAt,id)`, comparando o último ID visível de cada conversa com `lastObservedMessageId`; isso corrige em segundos saídas de campanhas/automação e falhas de observador. Em segundo plano, percorrer todas as conversas com mensagem em lotes de 50 e aplicar a mesma comparação, cobrindo histórico antigo e reinícios longos. Se uma conversa que a IA atendia passou ao controle humano com a última mensagem ainda de entrada, `decision=null` e `dueAt=null`, agendar análise para dois minutos após essa observação; se houver repasse, o card já aparece imediatamente pela regra da fila. A varredura recomeça do início após reinício e registros atualizados são ignorados, sem depender de checkpoint em memória. Limitar chamadas de modelo a três simultâneas. Registrar contadores sem incluir texto do cliente no log. Registrar `start()` e `onClose` em `app.ts`, somente quando Prisma estiver habilitado.
- [ ] **Step 5: Testar e commitar.** Run: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/conversations/inbox-triage-scheduler.test.ts` e `pnpm --filter @prymeira-talk/api typecheck`. Expected: PASS. Commit: `feat(talk): run durable inbox triage`.

### Task 6: Observar os caminhos reais de mensagens

**Files:** `apps/api/src/modules/evolution/evolution.routes.ts`, `apps/api/src/modules/meta/meta.webhooks.routes.ts`, `apps/api/src/modules/conversations/conversations.routes.ts`, `apps/api/src/modules/agents/agent-runtime.ts`, `apps/api/src/modules/conversations/realtime-outbound-delivery.ts`, `apps/api/src/app.ts` e testes correspondentes.

- [ ] **Step 1: Escrever testes que falham** para uma entrada Evolution, uma entrada Meta, uma saída humana do Talk, uma saída do WhatsApp externo e uma saída da IA. Cada mensagem nova chama `observeMessage` uma vez depois de persistir; webhooks duplicados não chamam. Falha do observador é registrada e não impede receber/enviar mensagem; o backfill repara.
- [ ] **Step 2: Confirmar falha.** Run: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/evolution/evolution.routes.test.ts src/modules/meta/meta.webhooks.routes.test.ts src/modules/conversations/conversations.service.test.ts src/modules/agents/agent-runtime.test.ts`. Expected: FAIL nas novas expectativas.
- [ ] **Step 3: Injetar `InboxTriageObserver` nos options e chamar após commit:**

```ts
await options.inboxTriage?.observeMessage({
  workspaceId,
  conversationId: message.conversationId,
  messageId: message.id,
  direction: message.direction,
  observedAt: new Date()
}).catch((error) => request.log.error({ err: error, conversationId: message.conversationId },
  "Inbox triage observation failed"));
```

Aplicar o mesmo contrato no Talk e na saída do agente; nos caminhos sem `request.log`, usar o logger do módulo. Observar apenas mensagens efetivamente persistidas após envio/recebimento, sem reservas `pending`, mensagens `system` ou reservas internas de follow-up; envio rejeitado não limpa pendência. Injetar o serviço em `app.ts` junto aos observadores existentes. A revisão periódica da Task 5 cobre campanhas, automações e importações que escrevam sem passar por essas rotas; conferir que ela não deixa um outbound posterior ressuscitar `needs_reply`.
- [ ] **Step 4: Testar e commitar.** Run: os quatro testes acima e `pnpm --filter @prymeira-talk/api typecheck`. Expected: PASS. Commit: `feat(talk): observe inbox messages across providers`.

### Task 7: Consultas paginadas e ações autenticadas

**Files:** `apps/api/src/modules/conversations/conversations.service.ts`, `conversations.routes.ts`, criar `inbox-triage.routes.ts` e `.test.ts`, modificar `apps/api/src/app.ts`.

- [ ] **Step 1: Escrever testes que falham** para 120 conversas e página 50: `view=unread|marked|reply|handoff` alcança itens da página 3; `reply` une repasse e triagem; `handoff` inclui apenas repasse pendente; canal/workspace isolados; ação manual de outro workspace dá 404; âncora ultrapassada dá 409; contagem de handoffs é total do canal.
- [ ] **Step 2: Confirmar falha.** Run: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/conversations/conversations.service.test.ts src/modules/conversations/inbox-triage.routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Ampliar `listConversationsQuerySchema` com `view: z.enum(["all","unread","marked","reply","handoff"]).default("all")` e trocar o filtro do servidor:**

```ts
const triaged: Prisma.ConversationWhereInput = {
  aiControlStatus: "human_controlled",
  inboxTriage: { is: {
    decision: { in: ["needs_reply", "uncertain"] },
    dismissedMessageId: null
  } }
};
const marked: Prisma.ConversationWhereInput = {
  inboxTriage: { is: { manualMarkedAt: { not: null } } }
};
```

Construir `handoffWhere` com a mesma regra de `needsHumanAttention` da Task 2; `reply` usa `OR: [handoffWhere, triaged]`; `unread` acrescenta `unreadCount: {gt:0}` a `OR:[handoffWhere,{aiControlStatus:"human_controlled"}]`. Combinar cada filtro com `workspaceId`, `channelId` e `status:"all"`, sem filtro client-side. Manter `orderBy` e cursor da lista atual; testes com inserções recentes devem provar que não há fim artificial depois de 50 itens. Expor `GET /conversations/attention-count?channelId=` com `count(where: handoffWhere)`.
- [ ] **Step 4: Criar rotas `POST /conversations/:conversationId/manual-mark`, `POST /conversations/:conversationId/reply-dismiss`, `POST /conversations/:conversationId/reply-undo`.** Body validado com Zod: `{marked:boolean}` para marca, `{anchorMessageId:uuid}` para dispensa/desfazer. Resolver ator do perfil atual, usar serviço da Task 3, devolver `ConversationDto` atualizado e publicar `conversation.updated`. Erros: 400 body inválido, 404 fora do workspace, 409 versão ultrapassada, 503 falha temporária.
- [ ] **Step 5: Testar e commitar.** Run: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/conversations/conversations.service.test.ts src/modules/conversations/inbox-triage.routes.test.ts` e `pnpm --filter @prymeira-talk/api typecheck`. Expected: PASS. Commit: `feat(talk): query and update shared inbox triage`.

### Task 8: Lista React, filtros e seleção estável

**Files:** `apps/web/src/app/api.ts`, `apps/web/src/features/inbox/InboxPage.tsx`, `apps/web/src/features/inbox/conversation-display.ts`, testes de filtro/lista.

- [ ] **Step 1: Escrever testes que falham** para seleção dos cinco views; troca de canal reinicia cursor; filtro ativo recarrega do servidor e não sobre a primeira página; evento `conversation.updated` remove card que deixou o filtro; abrir card não é desfeito quando marcar como lido faz ele sumir de **Não lidas**.
- [ ] **Step 2: Confirmar falha.** Run: `pnpm --filter @prymeira-talk/web exec vitest run src/features/inbox`. Expected: FAIL nas novas expectativas.
- [ ] **Step 3: Acrescentar APIs tipadas** `apiGetConversations(...,{view,channelId,cursor,status:"all"})`, `apiGetAttentionCount`, `apiSetManualMark`, `apiDismissReply` e `apiUndoReply`. Nas ações, usar exatamente o ID da âncora mostrado no DTO; exibir erro sem remover card quando a API falhar.
- [ ] **Step 4: Substituir `selectedQueueFilter` e `onlyHumanAttention` por `activeView: InboxView`.** `all|unread|marked|reply` pertencem à aba Conversas; `handoff` à aba Próxima ação. Remover os três contadores e chips de status. O `useEffect` de listagem e `loadMoreConversations()` passam `view` ao servidor e usam a geração existente para descartar respostas de filtro/canal anterior:

```tsx
const [activeView, setActiveView] = useState<InboxView>("all");
const listFilters = {
  status: "all" as const,
  view: activeView,
  ...(selectedChannelFilter !== "all" ? { channelId: selectedChannelFilter } : {})
};
const page = await apiGetConversations(getFreshToken, { ...listFilters, cursor });
```

Em views filtrados, evento `conversation.updated` recarrega a página atual em vez de fazer `upsertConversation` sem verificar pertença. Guardar um snapshot da conversa selecionada fora de `visibleConversations`, atualizá-lo quando chegar evento da mesma conversa e não trocar automaticamente o chat aberto quando uma leitura/dispensa remove o card da fila. Uma mudança explícita de card atualiza o snapshot; a lista inicial ainda pode selecionar o primeiro.
- [ ] **Step 5: Testar e commitar.** Run: `pnpm --filter @prymeira-talk/web exec vitest run src/features/inbox`, `pnpm --filter @prymeira-talk/web typecheck`. Expected: PASS. Commit: `feat(talk): load inbox views from server`.

### Task 9: Ícones, card e acessibilidade

**Files:** criar `apps/web/src/features/inbox/InboxQuickFilters.tsx` e `.test.tsx`, modificar `InboxPage.tsx`, `apps/web/src/styles.css`, testes de renderização da lista.

- [ ] **Step 1: Escrever testes que falham** para três botões acessíveis com `aria-pressed`/`aria-label`, `Próxima ação` preservada, marcador vermelho em card sem botão aninhado, botão de dispensa apenas para triagem semântica no view `reply`, texto **Humano necessário** no repasse, `Desfazer` por dez segundos e ausência dos três contadores e chips antigos.
- [ ] **Step 2: Confirmar falha.** Run: `pnpm --filter @prymeira-talk/web exec vitest run src/features/inbox/InboxQuickFilters.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Criar componente de filtros:**

```tsx
import { Bookmark, MessageCircleMore, MessageCircleReply } from "lucide-react";

const filters = [
  { id: "unread", label: "Não lidas no Talk", Icon: MessageCircleMore },
  { id: "marked", label: "Marcadas pela equipe", Icon: Bookmark },
  { id: "reply", label: "Responder", Icon: MessageCircleReply }
] as const;

export function InboxQuickFilters({ value, onChange }: {
  value: "all" | "unread" | "marked" | "reply" | "handoff";
  onChange(view: "all" | "unread" | "marked" | "reply"): void;
}) {
  return <div className="inbox-quick-filters" role="group" aria-label="Filtros rápidos">
    {filters.map(({ id, label, Icon }) => <button key={id} type="button"
      aria-label={label} title={label} aria-pressed={value === id}
      onClick={() => onChange(value === id ? "all" : id)}><Icon size={18} aria-hidden="true" /></button>)}
  </div>;
}
```

Nos cards, renderizar `Bookmark` separado do botão de abertura, com `aria-pressed`, e `MessageCircleX` de dispensa somente na triagem; `Humano necessário` continua o indicador existente. CSS usa o espaço liberado da linha de status e mantém alvos de toque de pelo menos 36 px sem adicionar linha repetida por card. Um toast com `role=status` oferece **Desfazer** por dez segundos após a dispensa.
- [ ] **Step 4: Verificar desktop e largura móvel** com screenshots do cabeçalho, filtro selecionado, repasse e card marcado. Confirmar que tooltips, foco visível, clique/touch e scroll funcionam e que a aba `Próxima ação` não desapareceu.
- [ ] **Step 5: Testar e commitar.** Run: `pnpm --filter @prymeira-talk/web exec vitest run src/features/inbox`, `pnpm --filter @prymeira-talk/web build`. Expected: PASS. Commit: `feat(talk): show compact inbox triage controls`.

### Task 10: Avaliação de qualidade, regressão e ativação

**Files:** ampliar testes dos módulos acima; criar `docs/operations/2026-09-25-inbox-triage-validation.md` com resultados agregados, sem conteúdo pessoal; atualizar `docs/production-deploy.md` apenas se a ativação exigir variável nova.

- [ ] **Step 1: Montar pelo menos 50 casos reais rotulados** de forma equilibrada, anonimizando qualquer fixture que entre no repositório. Cobrir orçamento pendente, dúvida técnica, catálogo entregue, “boa noite” inicial/final, “ok, obrigada”, recusa, anexo sem texto, repasse, resposta externa e mensagens espaçadas em um minuto.
- [ ] **Step 2: Rodar a comparação Luna/JEV** com `INBOX_TRIAGE_EVAL_FILE=./.local/inbox-triage-eval.jsonl pnpm --filter @prymeira-talk/api exec tsx scripts/evaluate-inbox-triage.ts`. Expected: relatório com casos perdidos, falsos alertas e latência dos dois. Criar esse JSONL local a partir dos 50 casos rotulados, fora de arquivos versionados. Escolher `INBOX_TRIAGE_PRIMARY` pelo menor número de pedidos reais perdidos; documentar a escolha e os erros remanescentes no arquivo de validação.
- [ ] **Step 3: Rodar regressão.** Run: `pnpm --filter @prymeira-talk/api test`, `pnpm --filter @prymeira-talk/api typecheck`, `pnpm --filter @prymeira-talk/web test`, `pnpm --filter @prymeira-talk/web build`. Expected: todos PASS. Validar que os testes de follow-ups, Aprimoramentos e repasse existente continuam iguais.
- [ ] **Step 4: Testar com o banco de homologação e UI**: aplicar migration em homologação, verificar worker após reinício, >50 conversas por filtro, atualização em duas sessões do mesmo número, leitura/dispensa sem troca inesperada do chat, recebimento Meta/Evolution e nenhum envio automático. Só então habilitar o classificador em produção; acompanhar logs de falha/latência e corrigir falsos negativos reais antes de considerar a entrega concluída.
- [ ] **Step 5: Commit de validação.** `git add docs/operations/2026-09-25-inbox-triage-validation.md` e eventuais testes finais; `git commit -m "test(talk): validate inbox triage quality"`. Expected: árvore limpa e relatório sem dados identificáveis.
