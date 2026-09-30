# Módulo IA para disparo — plano aprovado

Objetivo: ativar opcionalmente agentes de prospecção por campanha, conduzir respostas até um objetivo configurável de transferência e permitir retomadas apenas após engajamento.

Base de implementação: `3a4b2ca`, incluindo listas de disparo, fila persistente de campanhas Evolution e as correções recentes de envio, QR e reconexão. Reaproveitar agentes, sessões, scheduler, conhecimento, ferramentas, retomadas e resumo de transferência existentes.

## Decisões do usuário

- Módulo desligado inicialmente, ativado no fim de Configurações.
- Agente escolhido por disparo, de tipo Prospecção; agentes atuais continuam Atendimento.
- Objetivo de transferência configurável no agente; intervenção humana sempre prevalece.
- Retomadas configuradas por agente, somente após a primeira resposta nova ao disparo.
- Pular contatos já em atendimento humano, atribuídos a responsável ou com outro agente ativo.
- Autorizar respostas automáticas nas conversas da campanha inclusive em canais assistidos.
- Mensagem inicial preparada pela campanha; nenhum preset de retomadas.
- Primeira versão usa campanhas guiadas Evolution; Meta permanece separada.

## Contratos

- `AiAgentDto.type`: `attendance | prospecting`, padrão `attendance`.
- `handoffConfig.prospectingGoal`: instrução obrigatória para Prospecção.
- CRUD do agente expõe `followupConfig`, persistido em `behaviorConfig.followup`.
- Campanha: `prospectingAgentId` e `prospectingContext`, opcionais.
- Configurações: `modules.campaignProspecting`; `PATCH /settings/modules`.
- Conversa: `sourceCampaign: { id, name } | null`.
- Vínculo persistente registra origem, destinatário, confirmação do envio e primeira resposta; bloqueia campanhas concorrentes.

## Entregas e verificação

- [x] Dados, migração aditiva, contratos e APIs compatíveis com agentes/pacotes antigos.
- [x] Reserva e confirmação do envio; pular atendimento existente; tratar envio incerto e resposta durante confirmação.
- [x] Política compartilhada de autorização, prioridade de Prospecção e cancelamento por controle humano.
- [x] Retomadas por agente, cancelamento por nova resposta/recusa/encerramento e transferência com resumo.
- [x] Configurações, edição/teste de agentes, seleção por campanha e origem no inbox.
- [x] Revisão independente de conformidade com o plano, seguida de revisão de qualidade.
- [x] Testes de fluxo, concorrência, isolamento, histórico, desligamento e canal assistido.
- [x] Integração com banco descartável, verificação de tipos e build.
- [ ] Publicação de imagens compatíveis, migração anterior ao redeploy e healthchecks; módulo permanece desligado.

Pausar/concluir envios não encerra sessões já iniciadas. Desligar o módulo interrompe a IA e transfere para humano; religar não ressuscita sessões. Envios falhos/incertos não autorizam IA nem reenvio automático. Retomadas esgotadas não encerram a capacidade de responder a uma nova mensagem enquanto a sessão estiver ativa.

## Testes locais

Usar PostgreSQL descartável em localhost, banco `campaign_test`, com `CAMPAIGN_INTEGRATION_DATABASE_URL`. Nunca usar canais ou contatos reais para validar disparos. Executar testes afetados da API, shared e web, integração, `pnpm typecheck`, `pnpm build` e `git diff --check`.

Validação final em 30/09/2026: API 1.511 testes, shared 68, web 258 e integração PostgreSQL 55, todos aprovados. A suíte comum da API mantém 72 testes condicionais a banco desabilitados; os 55 cenários de campanhas/prospecção foram executados separadamente, em série. Passaram também `pnpm typecheck`, `pnpm build`, build de produção da API e `git diff --check`.

No navegador, validado em ambiente local com Evolution HTTP simulado: lista → criação do agente → rascunho → seleção/contexto → verificação e confirmação → envio inicial → webhook de resposta → resposta do agente → transferência para humano. Conferidos objetivo obrigatório, módulo desligado por padrão, origem no inbox após transferência e controles visíveis em largura de 679 px. O módulo local foi desligado novamente ao terminar.

Revisões independentes de backend, frontend e integração aprovadas após correções de concorrência, recuperação de envios, validação de retomadas e respostas simultâneas dos ajustes.

Migração e redeploy em produção ainda dependem do endereço e acesso ao ambiente de deploy. O roteiro está em `docs/operations/campaign-prospecting-rollout.md`; não habilitar o módulo em produção antes da validação do workspace.
