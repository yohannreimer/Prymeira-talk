# Plano de implementação — extensão do Talk

**Execução:** diretamente neste chat, sem subagentes, conforme pedido do usuário.

**Objetivo:** abrir no painel a conversa correspondente do Talk ao selecionar um contato no WhatsApp Web.

**Arquitetura:** extensão Manifest V3 com React; ponte autenticada na aba do Talk; resolução e autorização no backend existente. Reutilização das APIs de IA e follow-up. TypeScript, Zod, Fastify, Prisma e esbuild.

## 1. Base isolada e contratos

- [x] Criar branch `codex/whatsapp-web-extension-20261026` a partir da release remota `codex/ctwa-waha-release-20261022`.
- [x] Registrar desenho e contratos de comandos em `packages/shared/src/browser-extension.ts`.
- [x] Adicionar workspace `apps/extension`, build Manifest V3 e testes.

## 2. Resolver e autorizar a conversa

- [x] Criar `apps/api/src/modules/browser-extension/browser-extension.service.ts` e `.routes.ts`.
- [x] Validar perfil autenticado, canal, número verificado, aliases e autoridade existente.
- [x] Recusar conflitos, grupos e conversa de outro atendente.
- [x] Verificar a chegada ao Talk da última mensagem observada.
- [x] Cobrir os contratos por testes unitários e HTTP; executar `pnpm --filter @prymeira-talk/api exec vitest run src/modules/browser-extension`.

## 3. Reaproveitar autenticação e serviços

- [x] Criar página `/extension` em `apps/web/src/features/browser-extension` e registrá-la em `apps/web/src/app/App.tsx`.
- [x] Manter token dentro do Talk; expor somente comandos permitidos e resultados.
- [x] Invalidar autorização ao sair/trocar de conta e abortar operações da sessão encerrada.
- [x] Revalidar vínculo e versão antes de ações de follow-up.
- [x] Executar `pnpm --filter @prymeira-talk/web exec vitest run src/features/browser-extension/extension-bridge.test.ts`.

## 4. Extensão e concorrência

- [x] Implementar observação limitada de identidade, navegação e mudança de mensagens em `apps/extension/src/whatsapp`.
- [x] Implementar worker com isolamento por origem, aba, conversa e conta.
- [x] Implementar painel com sugestões editáveis, inserção protegida e follow-ups existentes.
- [x] Executar `pnpm --filter @prymeira-talk/extension test` e `pnpm --filter @prymeira-talk/extension build`.

## 5. Verificação e entrega

- [x] Executar `pnpm --filter @prymeira-talk/extension test:browser`; 13 cenários sintéticos passaram com content scripts, worker e página de conexão reais, incluindo isolamento entre janelas; zero erros de página.
- [x] Executar testes do Talk: API 3251 aprovados/871 condicionais ignorados, web 687, shared 133, extensão 14 e harness de validação 6; typecheck dos workspaces e builds API/web/extensão aprovados. FFmpeg/ffprobe isolados utilizados para testes de áudio, sem alteração do sistema.
- [x] Inspecionar capturas e empacotar extensão e guia em `outputs` da tarefa.
- [x] Registrar relatório factual em `work/relatorio-execucao.json` da tarefa; preservado localmente, sem enfileiramento/publicação no cérebro.

## Etapa posterior ao pacote local

Publicar API/web na release escolhida, carregar a extensão no Chrome de teste e validar o número piloto. Conferir o adaptador no WhatsApp real, mensagens enviadas nativamente, recebimento no Talk e interrupção dos follow-ups. Não é comprovado pelo ambiente sintético.
