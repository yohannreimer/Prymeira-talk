# Campanhas guiadas — publicação segura

Esta entrega adiciona a fila persistente de campanhas pela Evolution. O editor da Meta continua separado.

## Antes de publicar

1. Confirme que a branch usada para gerar as imagens contém tanto as alterações atuais da release quanto os commits de campanhas. Não use `latest` sem identificar o commit exato.
2. Registre os digests atuais das imagens da API e da web e confira se outro deploy da stack está em andamento.
3. Execute a migração aditiva `20260923000100_campaign_delivery_queue` com a **nova imagem da API** antes de atualizar serviços. Não execute a migração com a imagem antiga.
4. Atualize somente os serviços API e web do Prymeira Talk para imagens do mesmo commit. A fila só é processada quando `EVOLUTION_MODE=real` e a Evolution está configurada.
5. Verifique `/api/health`, `/api/ready`, logs do worker e a prévia de audiência num workspace de teste. Não use leads de produção nem envie mensagens reais para validar o deploy.

## Comportamento e recuperação

- Salvar um rascunho, preencher uma data e verificar números **não** envia mensagens. A ativação exige confirmação explícita e é idempotente.
- Rascunhos antigos sem jobs novos não são processados automaticamente. A rota legada `/send-real` responde `409 CAMPAIGN_REVIEW_REQUIRED`.
- Cada canal tem uma fila serializada. Intervalos e pausas são sorteados e persistidos; a janela e o fuso da campanha são respeitados pelo worker.
- Um resultado ambíguo pausa a campanha e bloqueia novos claims do canal. O operador deve conferir no WhatsApp e registrar o resultado manualmente; nenhuma tentativa automática de reenvio é feita.
- Em rollback, preserve a migração aditiva e os dados da fila. A imagem anterior da API não processará os jobs novos; ao retomar a imagem nova, os jobs `in_flight` expirados passam para revisão humana, sem reenvio automático.

## Verificação local reproduzível

Use um PostgreSQL **descartável** chamado `campaign_test` em localhost para o teste de integração. A variável `CAMPAIGN_INTEGRATION_DATABASE_URL` é aceita somente se a URL apontar para `localhost` ou `127.0.0.1` e para esse banco; os demais testes continuam sem credenciais de produção.

```sh
CAMPAIGN_INTEGRATION_DATABASE_URL='postgresql://...@127.0.0.1:PORT/campaign_test?schema=public' pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/web test
pnpm -r build
git diff --check
```
