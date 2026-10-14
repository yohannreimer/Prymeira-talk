# Publicar follow-ups da semana

A aba **Follow-ups da semana** usa uma seleção revisada manualmente, separada do agendador. Abre o histórico atual e usa o envio já existente do supervisor pelo número do vendedor. **Usar sugestão** só preenche o formulário; enviar exige ação explícita. Lembretes internos não podem preencher uma resposta ao cliente.

## Arquivo privado

Publicar o catálogo no volume privado da API: `${TALK_MEDIA_STORE_PATH:-/data/media}/supervision-followup-weeks.json`. `TALK_SUPERVISION_FOLLOWUP_WEEKS_FILE` pode apontar para outro arquivo privado. A API relê o arquivo em cada consulta. Não colocar dados reais no repositório público, no bundle web, no diretório de uploads ou em URLs públicas.

Formato: array de semanas, cada uma com `id`, `label`, `startDate`, `endDate` (datas YYYY-MM-DD) e `items`. Cada item contém `workspaceId`, `conversationId`, `kind` (`follow_up` ou `seller_reminder`) e `suggestion`. Não guardar cópias das mensagens: o histórico é lido na conversa real.

Exemplo fictício:

```json
[{"id":"2026-10-05","label":"5 a 11 de outubro de 2026","startDate":"2026-10-05","endDate":"2026-10-11","items":[{"workspaceId":"00000000-0000-4000-8000-000000000001","conversationId":"00000000-0000-4000-8000-000000000002","kind":"follow_up","suggestion":"Conseguiu avaliar o material?"}]}]
```

## Próxima sexta-feira

1. Revisar a nova seleção e incluir uma semana no array; manter as anteriores para consulta.
2. Validar localmente: `pnpm --filter @prymeira-talk/api exec tsx scripts/validate-supervision-followup-weeks.ts /caminho/privado/semanas.json`.
3. No volume do servidor, preservar a versão anterior, gravar a nova como arquivo temporário com modo 0600 e renomeá-la atomicamente para o caminho do catálogo. Manter proprietário igual ao processo da API.
4. Conferir a nova semana na Supervisão. A opção mais recente é a seleção padrão; o histórico de semanas também fica disponível. Não é necessário reiniciar ou alterar o banco.

Os números incluem somente conversas visíveis dos canais autorizados atualmente no Hub. Revogar acesso retira clientes, sugestões e contagens. Conversas ocultas ou consolidadas em outra conversa não são exibidas. A publicação não afirma que a pendência continua aberta; o supervisor deve conferir as respostas atuais antes de enviar.

Sem catálogo inicial, a aba mostra que nenhuma semana foi publicada. Arquivo explicitamente configurado inacessível ou catálogo inválido produz erro de consulta, sem usar dados antigos. Limites: 52 semanas e 500 conversas por semana, com até 4.000 caracteres por sugestão.
