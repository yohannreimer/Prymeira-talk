# Deploy de produção do Prymeira Talk

Este procedimento altera somente a stack do Prymeira Talk. Não remova imagens, volumes ou serviços de outros produtos.

## Ordem obrigatória

1. Registre os digests atuais das imagens da API e da web para possibilitar rollback.
2. Resolva `PRYMEIRA_TALK_DATABASE_URL` e `PRYMEIRA_TALK_IMAGE_TAG` usando os valores já configurados na stack.
3. Execute a migração em um contêiner one-shot com a nova imagem da API.
4. Reimplante somente a stack do Prymeira Talk.
5. Aguarde os healthchecks do PostgreSQL e da API ficarem saudáveis.
6. Verifique `/api/health` e `/api/ready`.
7. Execute os smoke tests do simulador do agente.
8. Remova somente imagens dangling e não utilizadas do Prymeira Talk, preservando a imagem ativa e uma anterior de cada serviço.

## Migração one-shot

Confirme as duas variáveis antes de executar. Pare imediatamente se qualquer uma estiver vazia.

```bash
test -n "$PRYMEIRA_TALK_DATABASE_URL" || { echo "PRYMEIRA_TALK_DATABASE_URL vazia"; exit 1; }
test -n "$PRYMEIRA_TALK_IMAGE_TAG" || { echo "PRYMEIRA_TALK_IMAGE_TAG vazia"; exit 1; }

docker run --rm \
  --network prymeiratalk_prymeira_talk_internal \
  --env DATABASE_URL="$PRYMEIRA_TALK_DATABASE_URL" \
  "ghcr.io/yohannreimer/prymeira-talk-api:$PRYMEIRA_TALK_IMAGE_TAG" \
  pnpm migrate:deploy
```

A migração não faz parte do comando de inicialização da API. Ela deve terminar com sucesso antes do redeploy.

## Validação

Espere o PostgreSQL e `prymeira_talk_api` ficarem `healthy`. Em seguida, valide que estes endpoints retornam HTTP 200 e identificam o produto `talk`:

```bash
curl --fail --silent --show-error https://talk.prymeiradigital.com.br/api/health
curl --fail --silent --show-error https://talk.prymeiradigital.com.br/api/ready
```

No simulador, teste uma pergunta comum, uma pergunta de preço sem evidência, uma solicitação explícita de atendente e uma resposta potencialmente longa. Confirme modelo, handoff, chunks selecionados e contagem de caracteres.

## Logs e diagnóstico de aprimoramentos

No Portainer, abra **Containers**, selecione o contêiner em execução de `prymeira_talk_api` e abra **Logs**. A tela de logs do serviço Swarm pode não carregar; a do contêiner permite buscar e baixar as linhas. Defina **Lines** e o período **Fetch** conforme o horário do caso.

Busque por `agent_improvement_observation`. Cada resposta humana analisada registra `source`, `conversationId`, `messageId`, `outcome` (`created` ou `skipped`) e `reason`. Uma falha técnica usa o evento `agent_improvement_observation_failed`. O texto da conversa e a chave do Jev não são incluídos nesses eventos. O motivo `not_a_durable_human_resolution_explicit_refusal_fallback` indica que o Jev descartou uma recusa explícita, mas o sistema criou uma sugestão para revisão. `detector_failed_explicit_refusal_fallback` indica falha técnica do detector seguida da mesma recuperação.

O `docker-compose.prod.yml` configura `json-file` com rotação de até 10 arquivos de 20 MB por contêiner. Isso limita uso de disco e mantém logs recentes consultáveis no Portainer; não é arquivo permanente. A rotação e a remoção do contêiner antigo podem apagar logs históricos. Para retenção entre implantações, configure um coletor central antes de depender desses registros como histórico. Ao aplicar a configuração, preserve os parâmetros e imagens da stack que estão efetivamente em produção; o arquivo do repositório não deve substituir a configuração ativa sem essa conferência.

## Retenção e rollback

Liste primeiro as imagens do Prymeira Talk e identifique por digest quais estão ligadas a contêineres ou serviços. Exclua apenas imagens dangling ou comprovadamente não utilizadas cujos repositórios sejam `prymeira-talk-api` ou `prymeira-talk-web`. Preserve a imagem ativa e exatamente uma anterior de cada serviço.

Se `/api/health`, `/api/ready` ou qualquer smoke test falhar, interrompa a limpeza, restaure na stack os digests de API e web registrados no início e reimplante somente o Prymeira Talk. Confirme novamente ambos os endpoints e os healthchecks após o rollback.
