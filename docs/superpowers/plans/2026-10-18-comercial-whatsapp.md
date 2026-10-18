# Atendimento comercial de entrada — Implementation Plan

> Execução nesta sessão, por etapas e sem delegação. Desenho aprovado pelo usuário.

**Goal:** criar atendimento comercial reutilizável e configurar um agente separado para o WhatsApp dos anúncios da Prymeira.

**Architecture:** compartilhar o core do harness, definir processo comercial próprio e carregar as informações de cada agente por configuração e fontes do seu workspace. Reutilizar a reserva existente de agenda.

**Tech Stack:** TypeScript, harness core, Vitest, Prisma e PostgreSQL.

## 1. Definição comercial

- [ ] Criar `apps/api/src/modules/harness/agentes/comercial/{tipos,instrucoes,index,producao}.ts` e `comercial.test.ts`.
- [ ] A ficha registra contexto informado, intenção atual, convite e solicitação de horário, sem confirmar uma reserva.
- [ ] Decidir em código entre responder, entender rotina, oferecer horários, solicitar reserva, encerrar e repassar.
- [ ] Validar seleção contra a lista de horários e a mensagem do contato. Não confirmar agendamento no texto do redator.
- [ ] Usar regras do core, proibir pressuposto de formulário e controlar repetição e perguntas. Verificar isolamento com outra empresa sintética.
- [ ] Rodar `pnpm --filter @prymeira-talk/api test -- src/modules/harness/agentes/comercial/comercial.test.ts`.

## 2. Runtime

- [ ] Adaptar `apps/api/src/modules/agents/agent-runtime.ts` para escolher comercial por configuração e canal explícito, preservando atendimento atual.
- [ ] Carregar disponibilidade e instruções do agente no comercial. Devolver `schedule_meeting` ao agendador existente, somente com texto revisado e seleção válida.
- [ ] Acrescentar regressões em `agent-runtime.test.ts` e rodar os testes de runtime, harness e agenda.

## 3. Configuração Prymeira e simulação

- [ ] Criar prompt versionado `apps/api/src/modules/agents/prymeira-whatsapp-definition.ts` e script de criação sem envio.
- [ ] Clonar as 12 fontes confirmadas atuais da Maria no mesmo workspace, com novos IDs; preservar o agente original e suas automações.
- [ ] Criar o agente separado sem associá-lo automaticamente a conversas existentes. Registrar configuração e eventual ativação real com precisão.
- [ ] Simular entradas de anúncio, dúvidas encadeadas, preço, integração, segurança, recusa, humano e agendamento. Não executar as ações retornadas.
- [ ] Rodar typecheck/build e registrar resultados e limitações em relatório local. Salvar relatório factual do Segundo Cérebro e enfileirar conforme autorização aplicável.
