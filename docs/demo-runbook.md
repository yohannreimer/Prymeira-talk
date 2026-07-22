# Roteiro da demo — Prymeira Talk

## Preparação

Na pasta do projeto, execute:

```sh
pnpm demo:reset
pnpm demo:prymeira
```

O primeiro comando inicia o PostgreSQL, aplica o schema e restaura o cenário. Ele usa Docker quando disponível e, se o Docker falhar, inicia uma instância local isolada em `.local/demo-postgres`. O segundo comando inicia API e web com autenticação e controles locais habilitados.

Abra `http://localhost:5176` em uma janela de pelo menos 1440 × 900. API e web usam, respectivamente, `http://localhost:3002` e `http://localhost:5176`.

## História principal — 10 a 12 minutos

1. Abra **Atendimento** e destaque as filas, os canais e os cinco responsáveis.
2. Clique em **Simular novo lead**. Carlos Mendes aparece no topo da fila.
3. Abra Carlos e mostre as perguntas da **Assistente Comercial IA**.
4. No painel direito, mostre `Orçamento quente`, o resumo da IA e o motivo do handoff.
5. Clique em **Assumir** para demonstrar a passagem de IA para humano.
6. Use a resposta rápida **Proposta em preparação** e envie a mensagem.
7. Em **Contatos**, abra o Pipeline comercial e mova Carlos para **Proposta enviada**.
8. Volte ao Atendimento, abra Carlos e clique em **Vincula**.
9. No CRM, confirme Carlos já selecionado. Clique em **Criar oportunidade** e depois em **Enviar nota da IA**.
10. Mostre os IDs, os status concluídos e o histórico. Termine em **Relatórios** para provar que as operações deixaram registros.

## Tour opcional — até 5 minutos

- **Equipe:** cinco vendedores, presença e distribuição em rodízio.
- **Agentes:** prompt, ações permitidas e base de conhecimento comercial.
- **Automações:** fluxo que qualifica, aplica tag e solicita handoff.
- **Disparos:** campanhas e audiência do pipeline.
- **Canais:** WhatsApp Comercial conectado e entrada de teste.

## Integrações reais e modo local

O fluxo principal usa integrações locais determinísticas. O Vincula grava histórico com o mesmo contrato da integração real, mas sem escrever fora do computador.

Para demonstrar o Vincula real, configure `VINCULA_CRM_API_URL` e entre com um token autorizado. Para WhatsApp real, configure `EVOLUTION_MODE=real`, `EVOLUTION_API_BASE_URL`, `EVOLUTION_API_KEY` e `EVOLUTION_WEBHOOK_SECRET`. Faça isso somente depois de ensaiar o caminho local.

Se internet, WhatsApp ou CRM real falharem, continue no ambiente local. A conversa, as notas, o funil e os relatórios não dependem dos serviços externos.

## Restaurar durante o ensaio

No Atendimento, clique em **Restaurar** e confirme. A operação afeta apenas `demo_workspace` e recria cinco vendedores, dez contatos, dez conversas, um agente e o histórico base.

Também é possível restaurar pelo terminal:

```sh
pnpm demo:reset
```

## Checklist antes da reunião

- [ ] Notebook conectado à energia e notificações desativadas.
- [ ] `pnpm demo:reset` termina com `Seeded 10 demo conversations for demo_workspace.`
- [ ] `pnpm demo:prymeira` mantém API e web em execução.
- [ ] `http://localhost:3002/health` responde com `ok: true`.
- [ ] Atendimento abre sem erros e mostra o selo **Demo local**.
- [ ] **Simular novo lead** abre Carlos e mostra resumo, tag e handoff.
- [ ] **Vincula** abre o CRM com Carlos selecionado.
- [ ] O botão **Restaurar** funciona e a simulação pode ser repetida.
- [ ] Se optar pelo caminho real, credenciais e internet foram testadas; o caminho local continua disponível.

## Observação deste computador

Em 22/07/2026, o Docker Desktop respondeu, mas o armazenamento interno do containerd apresentou `input/output error` em múltiplos blobs. Nenhuma imagem ou volume foi removido. O comando `demo:db` contorna o problema usando o PostgreSQL local. Reiniciar ou reparar o Docker Desktop é recomendável antes de voltar a depender dos contêineres de outros projetos.
