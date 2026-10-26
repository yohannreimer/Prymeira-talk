# Filas da extensão — plano de implementação

> Execução inline neste chat, sem subagentes, conforme instrução explícita do usuário. Usar executing-plans e verification-before-completion.

**Goal:** Encontrar pendências do Talk e abrir/preparar a conversa correta no WhatsApp Web.

**Architecture:** Filas e destinos autenticados somente de leitura; worker com autorização por conta e intenção de navegação; preparação revalida conversa e acompanhamento antes de inserir no campo vazio. Envio permanece no botão nativo do WhatsApp.

**Tech Stack:** TypeScript, Prisma/Fastify, React, Chrome Manifest V3, Vitest e Playwright.

## 1. Contratos e backend

- [ ] Estender `packages/shared/src/browser-extension.ts` com escopo do canal, filtros review/reminders/scheduled/human, resposta paginada mínima e comandos queue/navigate.
- [ ] Criar `apps/api/src/modules/browser-extension/browser-extension-queues.ts` e testes. Usar resolveAssistantActor, canal verificado, atribuição, inboxHandoffWhere e consultas paginadas com take 31, retorno 30. Contar os quatro filtros no mesmo escopo. Revalidar item e versão ao abrir.
- [ ] Registrar POST `/browser-extension/queue` e `/browser-extension/navigate`, ambos somente leitura e schemas estritos. Testar auth, workspace injection, cursor de outro canal e item fora da fila.

## 2. Ponte e worker

- [ ] Estender `apps/web/src/features/browser-extension/extension-bridge.ts` para os dois comandos fixos e retornar scope. Nenhuma rota de envio.
- [ ] Criar módulos de autorização da conta e intenção efêmera em `apps/extension/src/`; testar prazo, troca de conta/aba e consumo único.
- [ ] Adicionar QUEUE/OPEN_CHAT/PREPARE_FOLLOWUP ao protocolo. Worker valida conta/canal antes e depois de requisições, revalida destino, protege campo ocupado e navega somente para WhatsApp Web com telefone validado.
- [ ] Em PREPARE_FOLLOWUP, exigir intenção válida, resolver conversa atual igual ao destino, acompanhamento review não-reminder com mesmo id/updatedAt e rascunho não vazio; consumir intenção e usar WA_INSERT existente.
- [ ] Em `whatsapp/content.ts`, adicionar consulta de campo vazio e cancelamento de intenção por navegação/entrada manual, sem coletar texto. Revalidar lastMessageId também nos comandos atuais.

## 3. Painel

- [ ] Criar `QueuePanel.tsx` com abas, contador vermelho, filtros, estados vazio/erro/loading, atualização e paginação; sem redesign.
- [ ] Integrar com `panel.tsx`: filas disponíveis sem conversa selecionada, mas somente com conta/número correspondentes; clique abre e seleciona Conversa, prepara automaticamente apenas após confirmação da conversa esperada. Expirar intenção e mostrar aviso se bloqueada. Preservar rascunhos editados e demais ações existentes.
- [ ] Atualizar versão para 0.2.0 sem novas permissões de sites.

## 4. Verificação e entrega

- [ ] Escrever regressões antes das mudanças correspondentes; rodar testes focados até aprovação.
- [ ] Ampliar `apps/extension/tests/browser.mjs` para fila → abrir → preparar, motivo humano e bloqueios (campo ocupado, conversa errada, revisão alterada e navegação manual). Asserção de zero envios.
- [ ] Rodar typecheck/builds e suites relevantes, conferir diff, criar PR e aguardar CI. Publicar imagens exatas da revisão validada.
- [ ] Atualizar extensão instalada, API e web; conferir ao vivo somente leitura/navegação e preparação com campo vazio, sem enviar a cliente. Atualizar outputs e relatório factual local de execução conforme AGENTS.md.
