# Publicação do módulo IA para disparo

## Preparação

O módulo começa desligado em todos os workspaces. Agentes antigos continuam sendo do tipo Atendimento e campanhas antigas não recebem um agente automaticamente. Validar o fluxo em um banco descartável, com provedor simulado, antes de habilitar em qualquer workspace real.

1. Executar os testes da API, shared e web, incluindo integração com PostgreSQL descartável, `pnpm typecheck`, `pnpm build` e `git diff --check`.
2. Publicar imagens de API e web do mesmo commit. Usar a tag do SHA, não uma tag mutável, para identificar a entrega.
3. Registrar os digests ativos da API e web e conferir se há outra publicação do Talk em andamento.
4. Aplicar as migrações aditivas com a nova imagem da API antes de atualizar os serviços. Não executar migrações com a imagem anterior.
5. Atualizar apenas os serviços API e web do Talk, preservando a configuração ativa da stack.
6. Conferir os healthchecks e HTTP 200 em `/api/health` e `/api/ready`.
7. Conferir Configurações, edição de agentes e rascunho de campanha. Manter `modules.campaignProspecting` desligado em produção até a validação específica do workspace.

O workflow `Publish Docker images` aceita `workflow_dispatch` na branch da entrega e publica tags por SHA. Em execução manual ele não substitui `latest`.

## Validação funcional

- Ativar o módulo apenas no workspace descartável e criar um agente de Prospecção com objetivo explícito de transferência.
- Confirmar que um rascunho com IA exige agente ativo de Prospecção do mesmo workspace e canal Evolution.
- Executar a campanha usando cliente Evolution simulado. Sem resposta, nenhuma resposta de IA ou retomada deve ser enviada.
- Injetar uma resposta nova, incluindo uma chegada durante a confirmação do envio. Apenas o agente escolhido deve conduzir a conversa.
- Conferir origem da campanha e nome do agente no inbox; transferir pelo objetivo e manualmente, verificando que respostas e retomadas pendentes são canceladas.
- Repetir em canal assistido: a autorização específica da campanha permite a resposta do agente, sem sugestão paralela do atendimento.
- Confirmar que agentes/contatos já em atendimento, envios incertos, histórico importado e webhooks duplicados não geram atuação indevida.
- Desligar e religar o módulo: sessões interrompidas continuam sob controle humano.

## Recuperação

Envio incerto permanece em revisão, sem reenvio automático nem autorização da IA. Pausar ou concluir a fila não interrompe a prospecção de contatos que já responderam; desligar o módulo interrompe a atuação no workspace.

Antes de rollback para imagens anteriores a este módulo, desativá-lo nos workspaces onde tiver sido habilitado e conferir que não restam respostas/retomadas de prospecção em processamento. Preservar a migração e os dados de vínculo; restaurar os digests registrados e conferir novamente os healthchecks. Não apagar reservas, sessões ou destinatários para recuperar um envio.

## Migrações desta entrega

São cinco migrações aditivas: vínculo entre campanha e sessão, identificação de respostas ao disparo, geração do vínculo, lease persistente das respostas e instante da intenção de envio. A última preserva reservas antigas em envio ou incertas como bloqueadas; reiniciar um worker não deve reenviar mensagens com resultado desconhecido.

A reserva anterior à chamada do provedor pode ser liberada com segurança em pausa, cancelamento ou recuperação. Após persistir a intenção de envio, um resultado incerto exige revisão. As transações de prospecção usam a mesma ordem de bloqueio por conversa para serializar intervenção humana e desligamento do módulo.
