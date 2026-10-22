# Preparação CTWA pelo WAHA: operação e validação

Este recurso prepara atribuição de anúncios diretos para WhatsApp no ingresso WAHA existente. O caminho usa as mesmas autenticação, identidade canônica, transações e regras de canal do Talk. Não adiciona assinatura de webhook, pareamento, interface, fila de conversões, regras por palavras ou mudanças ao tracker do site/Cloudflare.

Esta implementação e suas fixtures são preparação local. Não comprovam recebimento CTWA real, configuração dos ativos Meta, permissão do token, compatibilidade de uma imagem WAHA real ou atribuição no Ads Manager. Implantação exige o gate de release do SHA exato, autorização de implantação e migrações no ambiente alvo. Este guia descreve o procedimento; a autorização para operar o ambiente e despachar um lead deve vir da tarefa do operador.

## Captura

O extrator aceita `ctwaClid` nativo da própria mensagem em `contextInfo.externalAdReply` (incluindo nomes protobuf Go camel/Pascal e wrappers ephemeral/view-once/document-with-caption, até seis níveis). O identificador opaco é conservado sem hash para o payload Meta; o hash serve apenas à deduplicação por workspace/canal. O `sourceID`/`sourceId` nativo pode fornecer o `adId` numérico opcional. Links, texto, contexto citado, grupos, saída, recibos e edições não produzem atribuição.

As FKs compostas do canal, conversa e mensagem comprovam o escopo do workspace; a captura não consulta nem cria workspace_mirrors. Após persistência canônica aceita, incluindo duplicatas de outro provedor, a atribuição fica vinculada ao workspace/canal/conversa/mensagem canônicos. Um clique já capturado nunca troca de conversa. Metadados inválidos são ignorados; uma falha no armazenamento opcional volta ao savepoint e preserva a transação de mensagens. Linhas anteriores não são reproduzidas ou varridas automaticamente para procurar cliques.

Somente a primeira captura em modo `live` prepara `LeadSubmitted` em `pending_validation`. O horário vem da ocorrência nativa validada, ou do `observedAt` confiável quando ausente. Capturas de ingresso em `history`/`recovered_live` são passivas, sem eventos automáticos. Uma captura passiva anterior não ganha LeadSubmitted automático se aparecer novamente ao vivo. A recuperação existente não é alterada para reprocessar histórico.

O campo auxiliar `ctwa` fica no blob privado normalizado e nas tabelas de atribuição, sem entrar nos novos payloads de observações canônicas. A comparação canônica também o desconsidera em linhas já existentes; identidade nativa e conteúdo continuam comparados integralmente. Isso conserva redelivery nas duas direções de implantação/rollback sem alterar observações antigas. Uma mensagem canônica admite somente um clique; metadados posteriores conflitantes não geram outro LeadSubmitted nem bloqueiam a mensagem. O importador os recusa com `message_click_conflict`.

As tabelas novas guardam IDs técnicos, clique/ad, horário, origem, valores de conversão e resumo seguro de envio. Não copiam telefone, corpo da conversa, payload bruto ou credenciais. Os identificadores de pedido devem ser técnicos e não conter dados pessoais. Leituras da API omitem o clique bruto e segredos.

## Configuração separada por workspace

O segredo de processo `META_WHATSAPP_CONFIG` contém um mapa JSON com chave igual ao workspace autenticado. Não há fallback entre clientes e não reutiliza configuração/pixel do site:

```json
{
  "workspace-id": {
    "datasetId": "123",
    "whatsappBusinessAccountId": "456",
    "pageId": "789",
    "accessToken": "SECRET_FROM_SECRET_MANAGER",
    "enabled": false,
    "testEventCode": "TEST_CODE_FROM_META"
  }
}
```

`datasetId`, `whatsappBusinessAccountId` e `accessToken` são obrigatórios para um envio habilitado; `pageId` é opcional e complementar. Validar a associação e as permissões desses ativos separadamente antes do teste real. `enabled` omitido equivale a `false`. Ausência, JSON inválido, workspace ausente ou configuração desabilitada bloqueiam antes de claim/fetch. Guardar pelo mecanismo de segredos do ambiente; não usar JSON em argumentos do terminal, logs, commits ou tickets. A configuração só é carregada na inicialização da API. Nenhuma API nova expõe ou altera o segredo.

O builder envia um único evento para `https://graph.facebook.com/v23.0/{datasetId}/events`, com `action_source=business_messaging`, `messaging_channel=whatsapp`, `user_data.ctwa_clid` intacto e `user_data.whatsapp_business_account_id`. `page_id` só acompanha quando configurado. O token segue no header Authorization, nunca na URL. `testEventCode`, quando presente, inclui `test_event_code`; remover somente após teste autorizado e antes de um envio real também autorizado.

## API autenticada

Usar o Bearer do Talk no workspace apropriado. Dono/gerente podem consultar; somente dono prepara ou despacha. O workspace vem da sessão autenticada: não enviar workspaceId no corpo/query. Todas as respostas usam `Cache-Control: private, no-store`.

| Método/caminho | Corpo ou filtros | Resultado |
| --- | --- | --- |
| `GET /attribution/ctwa` | `channelId` e/ou `conversationId` UUID opcionais; `limit` de 1 a 100, padrão 50 | Atribuições mais recentes, até 50 eventos mais recentes por atribuição, sem clique bruto/segredo; nenhuma preparação/envio |
| `POST /attribution/ctwa/{attributionId}/events` | `{"eventName":"QualifiedLead"}` | Prepara uma vez por atribuição; repetições retornam o mesmo evento |
| `POST /attribution/ctwa/{attributionId}/events` | `{"eventName":"Purchase","orderId":"order-001","value":100.50,"currency":"BRL"}` | Prepara compra distinta por pedido/workspace/canal |
| `POST /attribution/ctwa/events/{eventRowId}/dispatch` | `{"validated":true}` | Ação explícita do dono após conferir a origem/valor/configuração |

`eventRowId` é o `id` UUID retornado, distinto do `eventId` estável enviado à Meta. A API pública não permite preparar LeadSubmitted manualmente. A importação limitada abaixo atende somente recibos originais comprovados. Purchase exige `orderId` técnico de 1–128 caracteres (`A-Z a-z 0-9 . _ : -`), valor finito entre 0,0001 e 1 trilhão com até quatro casas decimais, e moeda de três letras maiúsculas. O mesmo pedido não pode ser atribuído a outro clique no mesmo workspace/canal; conflito de valor/moeda retorna `409 order_conflict`. Um novo pedido exige outro orderId. Não criar um identificador novo para contornar incerteza de envio.

Estados:

- `pending_validation`: somente preparado; nenhuma chamada Meta ocorreu.
- `sending`: claim SQL atômico adquirido. Leituras e reinícios não o reenviam. Uma queda neste ponto exige investigação manual.
- `accepted`: resposta HTTP de sucesso com `events_received=1`. Comprova aceite da API Meta, sem comprovar atribuição de anúncio ou entrega WhatsApp.
- `failed`: resposta 4xx completa com erro explícito Meta. Não há retentativa automática; um novo POST manual pode tentar o mesmo ID estável após corrigir a causa.
- `unknown`: timeout, conexão interrompida, resposta excessiva/inválida, 5xx ou falta de `events_received=1`. Reenvio pela API é recusado; revisar a evidência externa antes de qualquer intervenção futura.

O claim permite somente `pending_validation/failed -> sending`. Envios concorrentes geram no máximo uma chamada por claim. Não há expiração de claim, retomada de `sending`, reset de `unknown`, scheduler ou retry automático. O timeout padrão é 10 segundos, a resposta é limitada a 64 KiB e redirecionamentos são recusados. Erros e respostas externas não são devolvidos nem logados pelo módulo; ficam apenas status HTTP, quantidade recebida e código seguro. Nenhuma chamada de rede ocorre dentro da transação canônica.

## Lead anterior à implantação: importação autorizada por recibo

Para um lead identificado que chegou antes da captura CTWA, o operador autorizado pode preparar a atribuição e um único `LeadSubmitted` sem reaplicar a mensagem. Usar a imagem validada com acesso ao mesmo banco e volume privado de ingresso, com `DATABASE_URL` e `INGRESS_PRIVATE_ROOT` pelos mecanismos de segredo existentes. O comando não requer token Meta nem conexão com broker:

```sh
node dist/prepare-ctwa-receipt.js --workspace WORKSPACE_ID --receipt RECEIPT_UUID --event-index 0
# Conferir a prévia; --apply é explícito e prepara somente fatos locais.
node dist/prepare-ctwa-receipt.js --workspace WORKSPACE_ID --receipt RECEIPT_UUID --event-index 0 --apply
```

O padrão é somente leitura: verifica os digests de ambos os blobs privados e consulta o estado sob a trava canônica do workspace, sem criar diretórios, mensagem, progresso, efeito, atribuição ou conversão. A saída contém apenas prévia, estado e horário; não imprime corpo, telefone, clique ou segredo. `--apply` cria apenas atribuição e evento pendente. Não despacha para Meta; o despacho continua pela ação explícita do dono após configurar e conferir o workspace.

A prova exige recibo original autenticado `waha_raw_hmac_sha512`, modo original `live`, mesmo workspace/canal/tenant e sessão nativa. O normalizador atual deve aceitar a mensagem bruta e produzir a mesma chave nativa completa da mensagem aceita no blob normalizado original. Declarações contraditórias, índice inválido, normalização antiga incompatível ou necessidade de enriquecimento LID externo são recusados. Não se infere identidade por texto ou horário. O progresso original precisa estar `applied` e vincular a observação resolvida, identidade canônica ativa e mensagem individual inbound não ocultada por reset no mesmo escopo. Recertificação, replay ou progresso held não satisfazem esse comando. Gerações atuais dos provedores não são exigidas: a prova é histórica, sem recertificar autoridade de mensagem atual.

Repetições e concorrência preservam o primeiro vínculo e o evento existente, incluindo horário, estado, contagem e resultado de tentativas. Clique ligado a outra mensagem/conversa é recusado. Uma atribuição passiva já existente, no mesmo vínculo exato, pode ganhar `LeadSubmitted` somente por este comando explícito sustentado pelo recibo original ao vivo; a captura normal de histórico/recuperação continua passiva. O horário de criação do evento segue a ocorrência original validada, ou `observedAt` original na ausência dela. `sending`, `unknown`, `accepted` e `failed` existentes não são alterados, liberados ou reenviados.

## Primeiro lead real: pendente

1. Após implantação autorizada e gate de release, manter `enabled=false`. Aguardar a primeira mensagem de anúncio direto recebida naturalmente, sem replay antigo ou mensagens sintéticas a clientes.
2. Um dono/gerente consulta a atribuição pelo canal/conversa e confere a mensagem original no atendimento autorizado. Conferir vínculo e modo `live`, adId quando disponível e um único LeadSubmitted pendente com horário da ocorrência. Duplicata de Evolution/WAHA não deve criar outro evento. Sem contexto nativo, investigar o contrato do payload privado pelo procedimento autorizado; nunca inferir clique por frase ou URL.
3. Validar dataset/WABA/página e token do workspace na Meta. Com autorização específica para teste externo, configurar código de teste, habilitar apenas esse workspace e despachar uma vez com `validated=true`.
4. Conferir `accepted`/`events_received=1` no Talk e evidência de recepção no ambiente de testes Meta. Confirmar atribuição no relatório Meta separadamente; aceite isolado não a comprova. Se unknown/sending, parar e investigar sem repetir.
5. Somente depois dessa evidência e autorização para envio real, ajustar segredo/código de teste e registrar a decisão operacional. QualifiedLead e Purchase continuam ações manuais de dono, baseadas em fatos reais.

## Rollback e evidência local

Para interromper envios, desabilitar/remover a configuração do workspace e reiniciar a API pelo procedimento autorizado. Chamadas já em voo podem terminar; conservar `sending/unknown/accepted` para revisão. O rollback de código não deve apagar tabelas, reverter journal/identidade/coverage, executar replay ou liberar cercas de incerteza. As migrações são aditivas e as linhas podem permanecer sem consumidor. Antes de voltar a um worker anterior que não conhece o campo auxiliar CTWA, drenar os recibos já aceitos com o worker compatível ou conservá-lo durante o rollback da API: o worker antigo pode comparar o campo desconhecido ainda presente em um blob privado pendente. A compatibilidade das novas observações canônicas não altera binários anteriores nem reescreve esses blobs. Qualquer limpeza ou mudança manual de estado exige procedimento separado autorizado.

Os testes novos usam dados sintéticos e `fetch` injetado; nenhuma chamada WhatsApp/Meta real é necessária. O teste PostgreSQL exige opt-in `CTWA_TEST_DATABASE_URL` apontando para `127.0.0.1` com porta explícita e banco descartável `talk_ctwa_test` ou `messaging_test`. Nunca usar o DATABASE_URL herdado. O gate isolado mapeia essa variável ao fixture existente `messaging_test`. O teste cria e limpa apenas workspaces próprios e não executa migrações por conta própria. Aplicar as quatro migrações aditivas somente no fixture descartável para verificação local. O gate completo de release continua obrigatório antes de produção.
