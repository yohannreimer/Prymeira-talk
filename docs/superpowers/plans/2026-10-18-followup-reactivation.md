# Follow-up Reactivation Implementation Plan

**Goal:** recuperar negociações paradas com mensagens específicas e condições comerciais preservadas.

**Architecture:** manter o harness de análise, decisão, escrita e revisão. Ajustar política e contexto, sem criar outro motor nem alterar a cadência ou a fila.

**Tech Stack:** TypeScript, Vitest, harness de atendimento e provedores configurados.

Execução nesta sessão, sem subagentes, conforme pedido do usuário.

- [x] Acrescentar regressões em `apps/api/src/modules/harness/followup-reactivation.test.ts`: condição de vendedor, repetição útil, recusas específicas e contexto antigo; executar `pnpm --filter @prymeira-talk/api test -- src/modules/harness/followup-reactivation.test.ts` e verificar falha inicial.
- [x] Ajustar `agentes/atendimento/instrucoes.ts`, `juiz.ts`, `jogadas.ts`, `index.ts` e o contexto do runner; manter atendimento ao vivo intacto.
- [x] Acrescentar replay CLI que importa somente `seguirComHarness`, com arquivo de casos e configuração de provedor; sem cliente de banco, runtime ou transporte.
- [x] Executar regressões, testes de follow-up/harness e typecheck. Reproduzir os 23 casos com modelo real se o provedor estiver acessível; inspecionar mensagens e falhas, sem declarar aprovação apenas pela classificação.
- [x] Salvar resultado legível em outputs, revisar o diff e registrar evidências factuais no relatório do cérebro.
