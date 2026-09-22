# Leads Google e Receita Federal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o módulo único **Leads** para todos os papéis, permitindo encontrar empresas no Google Maps ou na base pública da Receita Federal, validar WhatsApp sem enviar mensagens e transformar seleções em contatos e rascunhos de disparo com proveniência, segurança e isolamento por workspace.

**Architecture:** O banco operacional do Prymeira continua em Prisma/PostgreSQL e armazena somente buscas, listas, resultados selecionados, jobs, verificações e proveniência por workspace. A base pública CNPJ fica em PostgreSQL separado (schema `cnpj`), carregada mensalmente pelo componente `cnpj-data-pipeline` fixado em revisão MIT verificada; a API a consulta somente para leitura por uma conexão dedicada. Adaptadores isolam Google Maps Scraper e Evolution. Jobs persistidos são processados pelo processo da API com lease, para poder retomar após reinício e expor estados claros ao frontend. Leads só cria contatos e campanhas em rascunho; o envio continua centralizado nos controles existentes de Disparos.

**Tech Stack:** Fastify, TypeScript, Prisma/PostgreSQL 16, `pg` para a base CNPJ read-only, React/Vite, Zod, Vitest, `gosom/google-maps-scraper` via o kit MIT `Mahanaicoach/google-maps-scraper-kit`, Evolution API e o pipeline MIT `caiopizzol/cnpj-data-pipeline`.

---

## Guardrails de produto e dados

- A navegação terá um único módulo lateral, `Leads`, com as fontes `Google Maps` e `Receita Federal`; `Minhas listas` será uma área persistente do módulo, não um terceiro tipo de fonte.
- `owner`, `manager` e `agent` terão a permissão nova `lead.manage`. Todo acesso a dados operacionais de Leads filtrará `workspaceId` no repositório e nas consultas de mutação.
- A base CNPJ pública é compartilhada e somente leitura. Listas, resultados salvos, importações CSV, validações, contatos e rascunhos pertencem exclusivamente ao workspace que os criou.
- P0 não inclui scraping de redes sociais, enriquecimento social, geração automática de texto, envio automático, disparo direto pela tela de Leads ou uma base CNPJ separada para cada cliente.
- A verificação WhatsApp usa apenas endpoint de disponibilidade da Evolution para números escolhidos pelo usuário. Ela nunca chama rotas `/message/*`, nem envia conteúdo.
- O componente externo CNPJ somente entrará no repositório depois de confirmar uma tag/commit que contenha licença MIT. O commit fixado e o texto integral do aviso serão versionados em `THIRD_PARTY_NOTICES.md` antes de qualquer deploy.
- CNPJ é tratado como texto normalizado em maiúsculas: após remover pontuação, `cnpj_basico` e `cnpj_ordem` admitem `[0-9A-Z]` e os dois dígitos verificadores são numéricos. Nenhuma etapa deve converter CNPJ para `number` ou pressupor 14 dígitos somente numéricos.

## Contratos de dados

### Dados operacionais no banco Prymeira

`LeadSource` terá valores `google_maps` e `receita_federal`; `LeadJobStatus`, `queued`, `running`, `completed`, `partial` e `failed`; `LeadWhatsappStatus`, `unverified`, `checking`, `available`, `unavailable` e `failed`.

- `LeadList`: lista nomeada por workspace, fonte, critérios serializados, contadores e datas. Uma busca cria ou atualiza uma lista antes de colocar seu job na fila.
- `Lead`: resultado normalizado por workspace e lista. Preserva os campos consultáveis (`companyName`, `tradeName`, `cnpj`, CNAEs, endereço, município/UF, telefones, email, website, avaliação, contagem de avaliações, coordenadas, URL de origem) e o snapshot bruto apenas quando necessário para auditoria. A unicidade usa a chave natural da fonte dentro da lista: CNPJ normalizado para Receita; URL Maps normalizada, ou nome/endereço/telefone normalizados como fallback para Google.
- `LeadJob`: trabalho persistido com entrada, saída resumida, erro sanitizado, tentativas, `leaseUntil`, `startedAt`, `finishedAt` e vínculo com lista. Um mesmo pedido idempotente possui `idempotencyKey` por workspace e operação.
- `LeadWhatsappVerification`: histórico por lead/telefone normalizado, canal Evolution, status, erro e data de verificação. A tela mostra o resultado mais recente.
- `LeadContactProvenance`: vínculo imutável de lead para contato com origem, lista, data, URL/fonte, estado de WhatsApp e snapshot da sugestão de texto. Não substitui campos que o usuário já tenha preenchido no contato.
- `ContactTag`: relação workspace-contato-tag. Importações garantem a tag `Origem: Lead Google` ou `Origem: Lead Receita` sem alterar tags existentes.

### Base pública CNPJ

A conexão `CNPJ_DATABASE_URL` aponta para banco separado ou conexão que tenha o schema `cnpj`; as credenciais da aplicação terão somente `SELECT`. As consultas usam tabelas do pipeline (`cnpj.empresas`, `cnpj.estabelecimentos`, `cnpj.cnaes`, `cnpj.municipios`, `cnpj.naturezas_juridicas`, `cnpj.dados_simples`) com parâmetros SQL, sem interpolar filtros ou ordenações do usuário.

O identificador exposto para a Receita é montado e armazenado como texto `cnpj_basico || cnpj_ordem || cnpj_dv`. Pesquisa por CNPJ usa igualdade com o valor normalizado; pesquisa por empresa usa texto normalizado/acento-insensível; filtros por CNAE aceitam principal e secundário; filtros de município/UF, porte, ativo, abertura, capital, telefone e email são aplicados no banco CNPJ.

### Score de empresas parecidas

O resultado será determinístico, limitado e explicável, de 0 a 100:

| Componente | Peso | Evidência exibida |
| --- | ---: | --- |
| Atividade | 35 | CNAE principal/secundário igual e grupo/setor equivalente |
| Localização | 25 | Mesmo município, UF ou distância quando houver coordenadas |
| Perfil | 20 | Porte, capital, natureza jurídica, Simples e faixa de idade |
| Prontidão comercial | 20 | Ativa, endereço, telefone e email disponíveis |

O CNPJ semente e todas as filiais com o mesmo `cnpj_basico` ficam excluídos. O frontend mostra o score e as razões, não apenas uma ordem opaca.

## Plano de execução

### Task 1 — Fixar dependências externas, infraestrutura e configurações

**Files:**
- Create: `infra/leads-cnpj/README.md`
- Create: `infra/leads-cnpj/docker-compose.yml`
- Create: `infra/leads-cnpj/.env.example`
- Create: `infra/leads-cnpj/update-cnpj-data.sh`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/env.ts`
- Modify: `docker-compose.dev.yml`
- Modify: `.gitignore` only if a generated CNPJ data directory is not already ignored

- [ ] Inspect the upstream Git history and release refs for `caiopizzol/cnpj-data-pipeline`; select a tag/commit where the repository itself contains an MIT `LICENSE` file, record the exact commit SHA, repository URL and retrieval date in `THIRD_PARTY_NOTICES.md`, and copy the complete MIT notice there.
- [ ] Vendor the selected upstream revision as a Git submodule at `infra/leads-cnpj/cnpj-data-pipeline` (or an immutable gitlink), never as an unpinned branch checkout; verify `git submodule status` resolves to the recorded SHA.
- [ ] Record the same source and MIT notice for `Mahanaicoach/google-maps-scraper-kit` and document that its runtime image is fixed at `gosom/google-maps-scraper:v1.15.0` until intentionally upgraded.
- [ ] Add `pg` and `@types/pg` to the API package with `pnpm --filter @prymeira-talk/api add pg` and `pnpm --filter @prymeira-talk/api add -D @types/pg`; commit the lockfile update.
- [ ] Add optional, validated environment settings in `apps/api/src/env.ts`: `CNPJ_DATABASE_URL`, `GOOGLE_MAPS_SCRAPER_URL`, `LEAD_GOOGLE_MAX_CONCURRENT_JOBS` (default 1), `LEAD_GOOGLE_DEFAULT_DEPTH` (fixed default 5), `LEAD_WHATSAPP_BATCH_SIZE` (default/max 25), and `LEAD_JOB_POLL_MS`.
- [ ] Create an internal-only CNPJ compose stack that runs the fixed pipeline against PostgreSQL 16 with schema `cnpj`, persisting raw downloaded files outside source control. Bind the database and scraper service only to loopback/private Docker networking; do not publish either to the internet.
- [ ] Make `update-cnpj-data.sh` run the pinned pipeline in its documented monthly mode with `DATABASE_URL` configured for `search_path=cnpj`, fail on an unpinned/dirty submodule, and print the dataset refresh date/version after a successful run. It must never receive Prymeira workspace credentials.
- [ ] Document a read-only database role and show exact environment examples for local development and production in `infra/leads-cnpj/README.md`.
- [ ] Run `pnpm install --frozen-lockfile`, `pnpm --filter @prymeira-talk/api typecheck`, and `git diff --check`. Expected result: the app can boot without these optional services; an unavailable source is surfaced only when its feature is invoked.

### Task 2 — Modelar o domínio, permissões e contratos compartilhados

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_leads_module/migration.sql`
- Modify: `apps/api/src/modules/access/roles.ts`
- Create: `apps/api/src/modules/leads/leads.types.ts`
- Create: `packages/shared/src/leads.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/realtime.ts`
- Create: `apps/api/src/modules/leads/leads.types.test.ts`

- [ ] Add Prisma enums and models from the data contract, all with workspace indices. Add `Contact.contactTags`, `Tag.contactTags`, and `ContactTag` with a composite primary key for `(workspaceId, contactId, tagId)`; retain existing conversation tags untouched.
- [ ] Add foreign keys and uniqueness constraints that make lead upserts idempotent and prevent a provenance or verification record from crossing workspace boundaries. Use `onDelete: Cascade` for operational lead rows that cannot survive their parent list/contact; retain only intentionally auditable records.
- [ ] Run `pnpm prisma migrate dev --name add_leads_module` from the root and inspect the generated migration rather than hand-writing a divergent schema. Run `pnpm prisma generate` afterward.
- [ ] Define public Zod request/response schemas in `packages/shared/src/leads.ts`: normalized CNPJ, search filters, paginated results, job status, CSV import response, similar-company score explanation, WhatsApp request/response, contact import result and campaign-draft result. Export them via `packages/shared/src/index.ts`.
- [ ] Add `lead.manage` to the role capability map and grant it to `owner`, `manager`, and `agent`. Keep `campaign.manage` unchanged, because that remains the enforcement point for actually sending campaigns.
- [ ] Add workspace-scoped realtime events `lead_list.updated` and `lead_job.updated`, with payloads that contain no cross-workspace lead data.
- [ ] Write unit tests for CNPJ normalization (`12.345.678/ABCD-90` becomes `12345678ABCD90`), rejected structural forms, batch-size boundaries, status transitions and shared-schema parsing. Expected result: alphabetic bases/order positions are accepted while invalid check-digit suffixes are rejected structurally.

### Task 3 — Criar a conexão read-only e repositório de consulta da Receita

**Files:**
- Create: `apps/api/src/plugins/cnpj-database.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/modules/leads/cnpj.repository.ts`
- Create: `apps/api/src/modules/leads/cnpj.repository.test.ts`
- Create: `apps/api/src/modules/leads/cnpj-normalize.ts`
- Create: `apps/api/src/modules/leads/cnpj-normalize.test.ts`

- [ ] Register a Fastify `cnpj` decorator backed by a small `pg.Pool` only when `CNPJ_DATABASE_URL` exists. It exposes a parameterized `query` interface, sets read-only transaction mode for each request/query path, and closes the pool during Fastify shutdown.
- [ ] Return a typed `LEAD_SOURCE_UNAVAILABLE` service error when the CNPJ connection is absent or unhealthy; never fall back to Prymeira's operational database.
- [ ] Implement CNPJ normalizing helpers as string operations: trim, remove separator punctuation, uppercase, validate `[0-9A-Z]{12}[0-9]{2}`, and format safely for display without numeric coercion.
- [ ] Implement repository methods with SQL placeholders and a fixed whitelist of sort columns: `findByCnpj`, `searchCompanies`, `searchEstablishments`, `getCompanyProfile`, and `findSimilarCandidates`.
- [ ] Query only active establishments by the official status code `02` where the user asks for active companies. Join names, CNAE descriptions, municipality descriptions, legal nature and Simples data. Return only fields needed by the Leads UI and stored result snapshots.
- [ ] Support city/UF, activity/CNAE (principal and secondary), porte, opening-date range, capital range, phone/email presence, company-name search and exact normalized CNPJ lookup. Parameterize all LIKE patterns and escape user wildcards.
- [ ] Write repository tests with a fake query client that verifies SQL never concatenates user values, maps an alphanumeric CNPJ round trip, applies secondary-CNAE matching, and returns the source-unavailable error cleanly.

### Task 4 — Persistir listas, resultados e jobs de Receita/CSV

**Files:**
- Create: `apps/api/src/modules/leads/leads.repository.ts`
- Create: `apps/api/src/modules/leads/leads.service.ts`
- Create: `apps/api/src/modules/leads/leads.scheduler.ts`
- Create: `apps/api/src/modules/leads/leads.service.test.ts`
- Create: `apps/api/src/modules/leads/leads.scheduler.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/main.ts` if shutdown wiring lives there

- [ ] Implement workspace-scoped CRUD for lists and lead result upserts. Every `find/update/delete` query includes both the resource id and `workspaceId`; missing or foreign resources return the same not-found response.
- [ ] Create a reusable job dispatcher with persisted `queued → running → completed|partial|failed` transitions, a lease to prevent duplicate workers, bounded retry accounting and sanitized failure messages. Reuse the established scheduler lifecycle pattern rather than keeping work only in memory.
- [ ] Register the scheduler once in `apps/api/src/app.ts`, poll at the configured interval, reclaim expired leases, and stop gracefully. Emit realtime updates on every meaningful job/list transition.
- [ ] Implement Receita search jobs: validate filters, create a list and idempotent job, page through the dedicated CNPJ repository with a hard server-side result ceiling, normalize and upsert rows, then calculate completed/partial counts.
- [ ] Implement CNPJ CSV jobs accepting a CSV upload with a required CNPJ column (case-insensitive aliases `cnpj`, `documento`), optional company/context columns and up to the documented safe file/row limits. Parse streams, normalize each CNPJ as text, de-duplicate input, look up valid CNPJs in batches and persist returned rows.
- [ ] Generate an error CSV for invalid, duplicate-unresolvable and not-found rows, persist an authorized workspace download record, and expose its metadata to the UI. Importing CSV never creates contacts or campaigns automatically.
- [ ] Write service and scheduler tests for duplicate job idempotency, crash/expired-lease recovery, partial CNPJ lookup, download authorization, malformed uploads, invalid row reporting and cross-workspace list isolation.

### Task 5 — Implementar empresas parecidas e explicação do ranking

**Files:**
- Create: `apps/api/src/modules/leads/similarity.service.ts`
- Create: `apps/api/src/modules/leads/similarity.service.test.ts`
- Modify: `apps/api/src/modules/leads/cnpj.repository.ts`
- Modify: `apps/api/src/modules/leads/leads.service.ts`
- Modify: `packages/shared/src/leads.ts`

- [ ] Resolve the seed from either an existing Receita lead or exact CNPJ lookup. Reject Google-only seeds without a CNPJ with a clear actionable response instead of inventing a company profile.
- [ ] Query a broad, bounded active candidate set using CNAE and UF first; exclude the seed's full CNPJ and every establishment sharing its `cnpj_basico` in SQL before scoring.
- [ ] Implement pure scoring functions that distribute the documented weights (activity 35, location 25, profile 20, commercial readiness 20), clamp totals to 0–100 and return a machine-readable list of matched reasons alongside each score.
- [ ] Treat missing data neutrally within a component rather than fabricating a match. Use straight-line distance only when both records actually have coordinates; otherwise use municipality/UF evidence.
- [ ] Create a persisted Receita list from selected similar candidates so it receives the normal selection, WhatsApp and conversion workflow.
- [ ] Test exclusion of the root CNPJ, repeatable tie-breaking, each score component, unknown values, reason text and workspace ownership of the saved list.

### Task 6 — Integrar Google Maps Scraper de forma limitada e recuperável

**Files:**
- Create: `apps/api/src/modules/leads/google-maps-scraper.client.ts`
- Create: `apps/api/src/modules/leads/google-maps-scraper.client.test.ts`
- Create: `apps/api/src/modules/leads/city-geocoder.ts`
- Create: `apps/api/src/modules/leads/city-geocoder.test.ts`
- Modify: `apps/api/src/modules/leads/leads.service.ts`
- Modify: `apps/api/src/modules/leads/leads.scheduler.ts`
- Modify: `packages/shared/src/leads.ts`
- Modify: `infra/leads-cnpj/docker-compose.yml`
- Modify: `infra/leads-cnpj/README.md`

- [ ] Implement an adapter for the kit's private REST API: health check `GET /api/v1/jobs`, create `POST /api/v1/jobs`, poll `GET /api/v1/jobs/{id}`, and download `GET /api/v1/jobs/{id}/download`. Keep this endpoint contract in one client so scraper releases do not leak through the domain service.
- [ ] Resolve `city, UF` to latitude/longitude through a small geocoder with a descriptive user agent, response cache and one-request-per-second throttle. Reject ambiguous/no-result city resolution with a user-facing correction rather than scraping an arbitrary place.
- [ ] Submit Google jobs with `keywords`, geocoded center, radius, `fast_mode: false`, default depth exactly 5 and bounded maximum execution time. Enforce one active Google scrape across the API process by default, even if multiple workspaces request it.
- [ ] Poll remote jobs through the persistent job scheduler. Download/parse the returned CSV on success, normalize name/category/address/city/phone/website/rating/review count/coordinates/source URL and upsert lean lead records to the workspace list.
- [ ] Convert upstream failed jobs, timeouts, rate limits and partial CSV parsing into `failed` or `partial` local job states with a safe retry button. Never leave a job indefinitely `running`.
- [ ] Make the service unavailable error explicit when `GOOGLE_MAPS_SCRAPER_URL` is absent. Search functionality remains available from Receita and no public browser/UI needs direct scraper access.
- [ ] Test endpoint requests, polling success, CSV normalization, depth/concurrency guards, rate-limit response, remote failure, timed-out job, city ambiguity and partial result completion.

### Task 7 — Verificar disponibilidade de WhatsApp com Evolution sem envio

**Files:**
- Modify: `apps/api/src/modules/evolution/evolution.client.ts`
- Modify: `apps/api/src/modules/evolution/evolution.client.test.ts`
- Create: `apps/api/src/modules/leads/lead-whatsapp.service.ts`
- Create: `apps/api/src/modules/leads/lead-whatsapp.service.test.ts`
- Modify: `apps/api/src/modules/leads/leads.service.ts`
- Modify: `apps/api/src/modules/leads/leads.scheduler.ts`
- Modify: `packages/shared/src/leads.ts`

- [ ] Add a narrowly named Evolution availability adapter that calls the installed Evolution version's documented `whatsappNumbers`/availability endpoint using the workspace's connected Evolution channel instance. Validate its response into normalized numbers and availability statuses.
- [ ] Assert in client tests that the adapter makes no call matching `/message/`, `/send`, media or template endpoints.
- [ ] On an explicit selected-lead request, create a persisted verification job. Select only valid phone fields, remove duplicates and cap each submitted batch at 25 numbers; a list with more selections becomes sequential jobs with per-instance rate limiting.
- [ ] Mark verification rows `checking` while running and write `available`, `unavailable` or `failed` results per phone. Retry a transient failure at most twice with bounded backoff, then preserve the error for a manual retry.
- [ ] Return `LEAD_EVOLUTION_NOT_CONNECTED` only for availability requests when no connected Evolution channel exists; it must not block searching, exporting, listing or importing leads.
- [ ] Test authorization, exact batch boundaries, no-channel behavior, adapter response variants, transient retry, permanent failure, deduplicated phones and latest status display selection.

### Task 8 — Converter leads em contatos, sugestão e rascunho de campanha

**Files:**
- Create: `apps/api/src/modules/leads/lead-conversion.service.ts`
- Create: `apps/api/src/modules/leads/lead-conversion.service.test.ts`
- Modify: `apps/api/src/modules/contacts/contacts.service.ts`
- Modify: `apps/api/src/modules/campaigns/campaigns.service.ts`
- Modify: `apps/api/src/modules/quick-replies/quick-replies.service.ts`
- Modify: `apps/api/src/modules/quick-replies/quick-replies.service.test.ts`
- Modify: `apps/api/src/modules/leads/leads.service.ts`
- Modify: `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/leads.ts`

- [ ] Add a transactionally safe `importSelectedLeads` flow: require an explicit selection, normalize each selected phone, find-or-create contacts by `(workspaceId, phone)`, and never overwrite an existing user-entered name, email, company, custom fields or tags.
- [ ] Add the source tag with `Tag.upsert` and `ContactTag.upsert`, using `Origem: Lead Google` and `Origem: Lead Receita`. Store full source/list/date/status metadata in `LeadContactProvenance` even when the selected lead reconciles to an existing contact.
- [ ] On the first Leads import for a workspace, ensure an editable quick reply titled `Prospecção — Clínica padrão`, category `Prospecção`, with this initial body: `Olá, tudo bem? Vi a {{company}} e queria entender como vocês organizam o atendimento pelo WhatsApp hoje.` Existing user-edited quick replies with the same title are preserved.
- [ ] Render `{{company}}` from the lead's trade name/company name at import time and store the resulting snapshot in provenance. This lets future template edits affect future imports without silently changing an operator's existing lead draft.
- [ ] Add a scoped composer-draft lookup from conversation to contact provenance. The result is returned only to the contact's workspace and only when it carries a lead suggestion; it provides text for the UI but never creates/sends a message.
- [ ] Add `createCampaignDraftFromLeads`: resolve selected contacts in the caller workspace, build the existing Campaign imported audience rows, use the editable/snapshotted prospecting text, create status `draft`, and return the campaign id. Do not invoke Campaign send/queue APIs from Leads.
- [ ] Permit all roles to create a Lead campaign draft through `lead.manage`, while preserving existing `campaign.manage` checks for edits/launches and all sending safeguards inside Disparos.
- [ ] Test same-workspace contact dedupe, non-destructive merge, tag idempotency, provenance retention, quick-reply creation/preservation, scoped draft retrieval, draft campaign payload and cross-workspace rejection.

### Task 9 — Expor rotas Fastify e integrar autorização/realtime

**Files:**
- Create: `apps/api/src/modules/leads/leads.routes.ts`
- Create: `apps/api/src/modules/leads/leads.routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/modules/leads/leads.service.ts`

- [ ] Register `/leads` routes behind the existing authenticated workspace request context and `lead.manage`: source/list summary, paginated list results, Receita search, exact CNPJ/company lookup, CSV upload/job status/error CSV download, similar-company job, Google search/job status, WhatsApp verification, selected-lead contact import, campaign draft creation and conversation composer draft.
- [ ] Use shared Zod schemas for request validation and typed response schemas. Apply a server-side maximum to every query, selection and upload irrespective of client values.
- [ ] Return `202 Accepted` for queued external/large jobs and `200` only for small synchronous reads. Return stable domain error codes for unavailable integration, validation errors, missing resources and operations not ready for retry.
- [ ] Make list/result endpoints return only the caller's workspace rows. Validate that every selected lead id belongs to the named list and current workspace before it reaches conversion or verification code.
- [ ] Publish `lead_job.updated` and `lead_list.updated` after successful commits, then subscribe only clients in the matching workspace.
- [ ] Write route tests with two workspace fixtures covering every mutation and download path, agent/manager/owner authorization, unauthorized users, malformed input, oversized selections, error status mapping and no implicit message-send request.

### Task 10 — Construir a experiência web do módulo Leads

**Files:**
- Create: `apps/web/src/features/leads/LeadsPage.tsx`
- Create: `apps/web/src/features/leads/LeadSearchPanel.tsx`
- Create: `apps/web/src/features/leads/LeadResultsTable.tsx`
- Create: `apps/web/src/features/leads/LeadListSidebar.tsx`
- Create: `apps/web/src/features/leads/LeadActionsBar.tsx`
- Create: `apps/web/src/features/leads/lead-display.ts`
- Create: `apps/web/src/features/leads/lead-display.test.ts`
- Create: `apps/web/src/features/leads/LeadsPage.test.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/shell/moduleRegistry.ts`
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Modify: `apps/web/src/features/contacts/ContactsPage.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] Add a single sidebar item `Leads` using the existing module registry. Route it through `App.tsx` without changing the current Inbox, Contacts or Disparos navigation behavior.
- [ ] Build the Leads screen with source tabs `Google Maps` and `Receita Federal`, a persistent `Minhas listas` panel, saved-list counts/status, source filters and an empty state that explains which source to use. All controls call the API; no scraper or Evolution credential reaches the browser.
- [ ] Google form accepts niche/atividade and city/UF, explains its conservative depth and displays queued/running/partial/failed state with retry. Receita form supports city/activity, company/CNPJ lookup, advanced filters, CNPJ CSV import and a download link for errors.
- [ ] Render results in a selectable, accessible table/cards with company, contact availability, address, CNAE/source, WhatsApp status and a source link. Use compact chips for source/status; never claim a number is WhatsApp-available before an explicit result.
- [ ] Add Similar companies from an eligible Receita result. Show score, reasons and exclusion context; allow saving selected candidates as a normal list.
- [ ] Add the bulk action bar: `Verificar WhatsApp`, `Cadastrar contatos` and `Criar lote de disparo`. Every action includes an explicit selected-count confirmation and clear post-action link respectively to Contacts or the Campaign draft in Disparos.
- [ ] Update contact opening flow: when a contact has lead provenance, the Contacts action opens Atendimento with `leadDraft=1` and conversation id. `InboxPage` fetches the scoped composer draft once, puts it into the editable composer only if it is still empty, removes the query flag via `history.replaceState`, and never sends it automatically.
- [ ] Add responsive CSS that follows the existing dark/teal card language, preserves the compact navigation density and makes source/status colors distinguishable with icon/text rather than color alone.
- [ ] Write frontend tests for CNPJ display, score reasons, disabled/available action states, job progress/error/retry, source tab switching, upload errors, selected-count actions and prefilled-but-unsent Inbox draft.

### Task 11 — Testar o fluxo completo e documentar a operação

**Files:**
- Create: `apps/api/src/modules/leads/leads.integration.test.ts`
- Create: `docs/leads-operations.md`
- Modify: `README.md`
- Modify: `THIRD_PARTY_NOTICES.md` only if a verified upstream revision changed during implementation

- [ ] Add an API integration test that creates two workspaces, searches/imports in one, proves the other cannot list, download, verify, convert or create a draft from those ids, and verifies the public CNPJ adapter has no workspace filter dependency.
- [ ] Add an end-to-end mock flow: Receita search → select → optional WhatsApp availability validation → import contacts/provenance/tag → open unsent composer draft → create Campaign draft → verify no message delivery call was made.
- [ ] Run the focused API and web tests, then the repository validation sequence: `pnpm --filter @prymeira-talk/api test`, `pnpm --filter @prymeira-talk/web test`, `pnpm -r typecheck`, `pnpm -r build`, and `git diff --check`.
- [ ] Document setup, CNPJ monthly refresh, fixed upstream revision and MIT notice, read-only credentials, private service networking, operational limits, retries, error states, backup/retention expectations and the distinction between a campaign draft and a sent campaign.
- [ ] Manually verify in the browser with mocked services that a user can complete both source flows, that all three roles see Leads, and that opening a converted lead puts a draft in the Inbox without sending it.
- [ ] Commit in reviewable slices: infrastructure/license, schema/contracts, Receita/jobs, Google, WhatsApp, conversion/routes, frontend, and tests/docs. Each slice must pass its relevant focused tests before the next slice begins.

## Verificação de aceite

- [ ] A pessoa vê apenas um item `Leads` na navegação e encontra as abas Google Maps e Receita Federal, além de suas listas persistentes.
- [ ] Google Maps realiza uma busca conservadora por vez, com profundidade 5, estados de progresso e recuperação de falha/rate limit.
- [ ] Receita consulta a base CNPJ compartilhada por cidade/atividade, empresa/CNPJ e CSV; aceita CNPJ alfanumérico corretamente e oferece CSV de erros.
- [ ] Empresas parecidas excluem a raiz do CNPJ de origem, recebem score 0–100 e explicam os motivos da posição.
- [ ] A verificação pela Evolution é opcional, limitada a 25 por lote, visível por status e comprovadamente não envia mensagem.
- [ ] Converter leads não cria dados fora do workspace, não sobrescreve campos do contato e preserva tags e proveniência de origem.
- [ ] A sugestão `Prospecção — Clínica padrão` é editável, aparece como rascunho no Atendimento e exige o clique humano para enviar.
- [ ] Criar lote gera somente uma campanha `draft`; Disparos continua responsável por validar e enviar.
- [ ] Falta de banco CNPJ, scraper ou canal Evolution gera erro específico na ação correspondente, sem inutilizar o restante do módulo.
