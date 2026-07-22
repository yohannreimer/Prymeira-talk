# Roteiro da demo — Prymeira Talk

## Preparação

Na pasta do projeto, execute:

```sh
pnpm demo:reset:all
pnpm demo:stack
```

O primeiro comando prepara o PostgreSQL local no SSD, aplica os dois schemas e restaura Talk e Vincula. O segundo mantém as duas APIs e as duas interfaces em execução. Deixe esse terminal aberto durante a apresentação.

Em outro terminal, confirme a saúde da stack:

```sh
pnpm demo:check
```

O resultado esperado é `Stack saudável; dois apps, duas interfaces e bancos persistidos no SSD.`

Abra `http://localhost:5176` em uma janela de pelo menos 1440 × 900. O Talk usa API `http://localhost:3002`; o Vincula usa web `http://localhost:5174` e API `http://localhost:3003`.

## História principal — 10 a 12 minutos

1. Abra **Atendimento** e destaque as filas, os canais e os cinco responsáveis.
2. Clique em **Simular novo lead**. Carlos Mendes aparece no topo da fila.
3. Abra Carlos e mostre as perguntas da **Assistente Comercial IA**.
4. No painel direito, mostre `Orçamento quente`, o resumo da IA e o motivo do handoff.
5. Clique em **Assumir** para demonstrar a passagem de IA para humano.
6. Use a resposta rápida **Proposta em preparação** e envie a mensagem.
7. Em **Contatos**, apresente os contatos existentes; depois abra o Pipeline comercial de Carlos e mova-o para **Proposta enviada**.
8. Volte ao Atendimento, abra Carlos e clique em **Vincula** para iniciar a sincronização.
9. No CRM, confirme Carlos já selecionado. Clique em **Criar oportunidade** e mostre `Sincronizado no Vincula local`, os IDs reais e o botão **Abrir no Vincula**.
10. Clique em **Abrir no Vincula**. A nova aba abre a ficha nativa dentro do Kanban, no estágio **Oportunidade**, com origem **Prymeira Talk**, probabilidade de 75% e Marina Costa como responsável.
11. Volte ao Talk, clique em **Enviar nota da IA** e retorne à aba do Vincula. Atualize a ficha para mostrar a nota no histórico sem duplicar empresa, contato ou negócio.
12. Termine em **Relatórios** para provar que as operações também deixaram histórico no Talk.

## Tour opcional — até 5 minutos

- **Equipe:** cinco vendedores, presença e distribuição em rodízio.
- **Agentes:** prompt, ações permitidas e base de conhecimento comercial.
- **Automações:** fluxo que qualifica, aplica tag e solicita handoff.
- **Disparos:** campanhas e audiência do pipeline.
- **Canais:** WhatsApp Comercial conectado e entrada de teste.

## O efeito de integração real local

O fluxo principal grava dados reais em dois bancos PostgreSQL locais: o Talk cria ou reutiliza empresa e contato, cria o negócio no Vincula e envia as notas para `deal_notes`. O botão **Abrir no Vincula** leva diretamente à ficha nativa criada. Não é uma tela simulada e não depende da internet.

Os registros-base do Vincula são neutros — serviços empresariais, mobiliário, logística e equipamentos — para que o cenário possa ser reutilizado em demonstrações de clientes de diferentes segmentos.

Para demonstrar o Vincula real, configure `VINCULA_CRM_API_URL` e entre com um token autorizado. Para WhatsApp real, configure `EVOLUTION_MODE=real`, `EVOLUTION_API_BASE_URL`, `EVOLUTION_API_KEY` e `EVOLUTION_WEBHOOK_SECRET`. Faça isso somente depois de ensaiar o caminho local.

Se internet, WhatsApp ou CRM real falharem, continue no ambiente local. A conversa, as notas, o funil e os relatórios não dependem dos serviços externos.

## Restaurar durante o ensaio

No Atendimento, clique em **Restaurar** e confirme. A operação restaura primeiro o workspace local do Vincula e depois o `demo_workspace` do Talk. Ao terminar, a tela informa que Talk e Vincula estão prontos.

Também é possível restaurar pelo terminal:

```sh
pnpm demo:reset:all
```

O reset remove somente os dados dos workspaces locais fixos da demonstração. Antes da criação ao vivo, o Vincula mostra nove contatos originados no Talk e seis negócios históricos. Carlos Mendes aparece somente depois da sincronização.

## Fallback Talk-only

Se você quiser demonstrar apenas o Talk, sem abrir o Vincula local, use:

```sh
pnpm demo:reset
pnpm demo:prymeira
```

Esse caminho mantém o comportamento anterior do Talk e não altera os comandos da demo integrada.

## Checklist antes da reunião

- [ ] Notebook conectado à energia e notificações desativadas.
- [ ] `pnpm demo:reset:all` termina confirmando 10 conversas, 9 contatos e 6 negócios históricos.
- [ ] `pnpm demo:stack` mantém os quatro serviços em execução.
- [ ] `pnpm demo:check` confirma os dois apps, as duas interfaces e o armazenamento no SSD.
- [ ] Atendimento abre sem erros e mostra o selo **Demo local**.
- [ ] **Simular novo lead** abre Carlos e mostra resumo, tag e handoff.
- [ ] **Vincula** abre o CRM com Carlos selecionado e cria a oportunidade com IDs reais.
- [ ] **Abrir no Vincula** abre `http://localhost:5174/#/deals/{id}/show` e exibe a ficha sobre o Kanban.
- [ ] **Enviar nota da IA** adiciona uma nova nota na mesma oportunidade.
- [ ] **Restaurar** confirma os dois produtos e permite repetir toda a história.
- [ ] Se optar pelo caminho real, credenciais e internet foram testadas; o caminho local continua disponível.

## Observação deste computador

Em 22/07/2026, o Docker Desktop respondeu, mas o armazenamento interno do containerd apresentou `input/output error` em múltiplos blobs. Nenhuma imagem ou volume foi removido. A demo integrada força o PostgreSQL local isolado em `.local/demo-postgres`, no SSD, e não depende do Docker. Reiniciar ou reparar o Docker Desktop é recomendável antes de voltar a depender dos contêineres de outros projetos.
