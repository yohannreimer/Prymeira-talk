# Photo Optimization Implementation Plan

> Execução inline por autorização explícita do usuário; sem subagentes. Usar executing-plans e verification-before-completion. Salvar localmente, sem commit/push/deploy.

**Goal:** Reduzir fotos antes do upload sem processamento de compressão no VPS e sem perder arquivos/legendas em falhas.
**Architecture:** engine de JPEG em Worker efêmero, coordenador serial com timeout e fallback ao original, opção por arquivo na bandeja e integração no envio existente.
**Tech Stack:** React, TypeScript, Vite, Canvas/OffscreenCanvas, Worker, Vitest.

- [x] Criar regressões para elegibilidade, dimensões, economia mínima e coordenador de Worker. Comando: `pnpm --filter @prymeira-talk/web exec vitest run src/features/inbox/photo-optimization.test.ts` (falha antes dos módulos).
- [x] Criar `photo-optimization-engine.ts`, `photo-optimization.worker.ts` e `photo-optimization.ts`. JPEG somente, >512KiB, 2560px/0.85, <=60MP, 8s, preservar em falha; confirmar testes anteriores.
- [x] Atualizar `PendingAttachment`/`AttachmentTray` com enviar original; integrar preparação em `InboxPage`, manter original/legenda/preferência para retry e seleção de conversa. Criar testes de lote e falha em `InboxPage.performance.test.tsx`.
- [x] Validar engine real em página local de fixtures sintéticas, incluindo EXIF e documentos/PNG/GIF/WebP intocados; verificar Worker do build e CSP real.
- [x] Rodar suite web, typecheck/build web; API/shared regressões conforme escopo. Rodar `git diff --check` e revisar mudanças.
- [x] Guardar patch, resultados e relatório factual local na pasta da tarefa; nenhum conteúdo publicado.
