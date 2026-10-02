# Evolution + WAHA e RabbitMQ — operação e qualificação

Este documento acompanha a integração. Inventário e testes observados são evidências; os critérios de publicação abaixo ainda precisam ser concluídos.

## Destino e inventário observado em 30/09/2026

Destino autorizado: VPS existente, gerida em `https://painel.yrdnegocios.com.br`, ambiente Portainer `primary` (endpoint 2).

- Swarm: um nó `srv1904129`, 2 CPUs e aproximadamente 8,3 GB de RAM. A indisponibilidade desse nó interrompe todos os serviços nele.
- Talk API e web no inventário inicial: imagem do commit `0b7c213`, uma réplica de cada. PostgreSQL 16 existente. A frente de desempenho está atualizando API/web; incorporar seu estado final confirmado conforme a coordenação abaixo.
- Broker a reutilizar: serviço `rabbitmq_rabbitmq`, imagem `rabbitmq:3.12.14-management-alpine`, uma réplica, persistência em `/var/lib/rabbitmq`, rede `network_swarm_public`, sem portas publicadas. Digest observado: `sha256:0b44fbcc3a4bf22d00090f1353127577dbe1fcb109c41669733a9d7ecf6c3a78`.
- O detalhe do container confirmou o volume efetivo `rabbitmq_data` em `/var/lib/rabbitmq`. Preservar esse mount ao configurar o acesso dedicado do Talk.
- Consulta `rabbitmqctl` somente de leitura: um vhost existente; nele, 21 filas, 23.250 mensagens prontas, zero mensagens sem ACK e zero consumidores no instante observado. Memória agregada das filas: 8.378.108 bytes. Esses contadores pertencem à infraestrutura anterior e não medem o pico do Talk. Não consumir nem purgar essas filas durante a integração.
- Não utilizar o broker separado `operis_pluris_rabbitmq`.
- WAHA autorizada para reutilização: `deskcomm_waha`, uma réplica. Imagem atual `devlikeapro/waha:latest-2026.7.2`, digest `sha256:65e593e30bb702f891550b9da5d65e9e0eff8a926f5451fac6a582db84d3a323`, engine configurado `NOWEB`. Volumes existentes em `/app/.sessions` e `/app/.media` devem ser preservados.
- Os detalhes do container em execução confirmaram os mounts `deskcomm_waha-data` → `/app/.sessions` e `deskcomm_waha-media` → `/app/.media`, e somente a rede `deskcomm_internal`. Os nomes exibidos como opções no editor do serviço não substituem esses mounts observados. A comunicação privada com os novos processos do Talk ainda precisa ser configurada e qualificada.
- A consulta autenticada por HTTP, usando a configuração já existente dentro do aplicativo Deskcomm, confirmou WAHA `2026.7.2`, engine `NOWEB`, tier `CORE`, e uma sessão em estado `FAILED`. Seu proprietário difere do número autorizado para homologação. Não adotar nem substituir essa sessão como sessão de teste do Talk. A chave não foi extraída nem registrada.
- Evolution existente: `evoapicloud/evolution-api:2.4.0-rc2`. Esta integração não depende de atualizar sua versão.

O hostname `manager01` no exemplo antigo de stack não corresponde ao nó observado. A configuração efetiva do Portainer deve ser preservada ao atualizar a stack; não substituir variáveis e credenciais pelo conteúdo de um exemplo.

## Coordenação com a frente de desempenho

A frente de cache/navegação está no [PR #6](https://github.com/yohannreimer/Prymeira-talk/pull/6), partindo da mesma base `4524fbb`. Yohann autorizou a coordenação entre as conversas. Essa frente publicará primeiro depois de concluir suas validações. Antes do rollout desta integração, incorporar aditivamente seu SHA final confirmado, preservando as mudanças de leitura, cache, autenticação e eventos; repetir as regressões combinadas. Não substituir arquivos inteiros por cópias da base. Nenhuma imagem API/web foi alterada por esta integração até este registro.

## Imagem candidata da WAHA

A documentação oficial indica a variante Chrome para receber vídeo. Candidata verificada no registro Docker, ainda não executada nem homologada:

```text
devlikeapro/waha:chrome-2026.9.1@sha256:23d0344ea7dd3a1190d9ee5c78efebd27eb8bb41bdc6cdc10c2e2ce186ce70d5
linux/amd64: sha256:4518bced9c24e93ef34679399ce8be9c976f743de64b388214ba1fd7800b72dc
WHATSAPP_DEFAULT_ENGINE=WPP
```

Verificação realizada: `docker buildx imagetools inspect devlikeapro/waha:chrome-2026.9.1`. A aplicação deve conferir versão e engine reais antes de criar/vincular sessões. Digest válido não comprova compatibilidade funcional.

NOWEB e WPP têm namespaces de sessão distintos. Preservar o volume original e configurar um namespace WPP próprio do Talk, verificado contra os dados existentes; não reaproveitar arquivos de autenticação NOWEB como se fossem WPP. A mudança poderá exigir leitura de um novo QR Code. Conferir o inventário das sessões antes de alterar o serviço.

Fontes: [engines e imagens WAHA](https://waha.devlike.pro/docs/how-to/engines/), [release 2026.9.1](https://github.com/devlikeapro/waha/releases/tag/2026.9.1), [autenticação WAHA](https://waha.devlike.pro/docs/how-to/security/).

## Decisões de persistência

- Eventos recebidos e sua referência durável pertencem ao PostgreSQL do Talk. A fila transporta IDs/referências e metadados limitados, nunca arquivos, chaves de mídia ou credenciais.
- Mídia original e derivados usam armazenamento privado do Talk em volume persistente compartilhado pelos processos que precisam desses bytes. Não utilizar `/uploads/automations` para anexos privados.
- Publicação aceita somente após confirmação do broker. Mensagem, observações e efeitos pendentes precisam de uma transação canônica antes do ACK do consumidor.
- O acesso ao broker deve usar vhost/filas próprios do Talk, preservando os outros produtos. Não publicar portas adicionais.
- Manter API, ingresso e workers na mesma imagem de um commit. API e interface não são pré-requisitos para aceitar eventos no ingresso.

Operações de QR e desconexão da mesma conexão física são serializadas. Uma operação interrompida pode deixar um token de lifecycle pendente; a implementação final precisa recuperar esse estado explicitamente, verificando o processo/provedor antes de concluir ou reiniciar a operação. Uma sondagem de saúde ou uma requisição comum de QR não pode assumir abandono nem restabelecer elegibilidade durante I/O pendente. Operações entre Evolution e WAHA continuam independentes.

## Pico observado e perfil de carga

Consulta agregada somente de leitura no PostgreSQL de produção, sem conteúdo de mensagens nem identificadores pessoais: últimos sete dias, direção inbound, excluindo registros com marcador `historyImport`. Foram observadas 1.134 mensagens, pico de 11 em um minuto e 4 em um segundo. Não se presume que todo esse tráfego represente clientes reais.

O teste da nova integração deve usar ao menos 8 mensagens canônicas por segundo, com observações de Evolution e WAHA (16 envelopes por segundo), mais reentregas e eventos atrasados. Registrar separadamente a latência do aceite, da persistência no Talk e da preparação de mídia/IA. Essa medição define o piso de qualificação desta publicação; não comprova capacidade futura da VPS.

## Ambiente local de testes

PostgreSQL 16.14 e RabbitMQ 4.3.6 executados somente em loopback, em dados descartáveis próprios da tarefa. O protocolo usado deve ser compatível com AMQP 0-9-1 e o broker 3.12.14 da VPS. Repetir a qualificação no broker de produção usando um vhost de homologação isolado.

Evidências iniciais, antes da integração:

- Shared: 77 testes aprovados.
- Web: 299 testes aprovados.
- API: 1.536 aprovados, 78 condicionais não executados nesse primeiro comando.
- Banco real: 61 testes de campanhas, prospecção e supervisão aprovados em PostgreSQL local.
- Banco real: mais 17 testes de assistente e leads aprovados em bancos PostgreSQL locais separados, com as 39 migrações existentes nesse estágio.
- Listener AMQP local confirmado por `rabbitmq-diagnostics listeners`, em loopback.

Bloco 1 implementado localmente e aprovado nas revisões de especificação e qualidade em `95fb0b8`: conexões físicas aditivas, cliente WAHA, dois QR Codes, estados individuais e fencing persistente das operações. Rodada completa da API: 1.587 testes aprovados, 103 condicionais não executados nesse comando. Os 25 testes de conexões/migração com PostgreSQL foram executados separadamente e aprovados. Verificação independente focada: 165 testes aprovados em oito arquivos, incluindo PostgreSQL. Typecheck dos três pacotes e build da API aprovados. A rodada anterior da interface aprovou 313 testes; as últimas correções alteraram somente API e testes. Esses resultados não homologam sessões WPP reais nem comprovam o percurso RabbitMQ, o armazenamento próprio de mídia ou o roteador, que ainda serão implementados.

Bloco 2a.1 implementado localmente em `dd2eb72`: extração Evolution compatível e adaptadores puros, contratos de mensagem/mídia/ações/recibos, identidade exata e patches de texto/legenda. As revisões independentes encerraram os achados de mídia pendente, chat não comprovado, autor de exclusão, legenda e campos malformados. Verificação independente final: 173 testes em quatro arquivos, incluindo 68 da rota Evolution legada; typecheck e build da API com Node 22.22.0/pnpm 10 aprovados. Antes das correções finais restritas aos adaptadores, a rodada completa aprovou 1.654 testes da API, 313 da interface e 79 compartilhados, com 103 testes condicionais da API não executados. Uma rodada concorrente produziu três timeouts em testes existentes de Leads; a repetição da interface com dois workers passou sem alterar testes ou timeouts. A causa não foi comprovada. Os adaptadores ainda não estão conectados aos escritores; esses resultados não comprovam deduplicação persistente nem paridade real dos provedores.

Bloco 2a.2A implementado localmente em `a71390d`: migrações aditivas de endereços, chats, membros, identidades, aliases e observações, com backfill conservador dos registros existentes. O store serializa escritores canônicos em transações READ COMMITTED e mantém UUIDs e FKs de origem. Provas explícitas PN/LID unem identidades; duas conversas existentes ficam sem autoridade operacional até resolução explícita. A adoção de uma mensagem de grupo verifica o remetente dos metadados e de todos os snapshots legados; contradições são preservadas para revisão, sem vínculo incorreto. Conformidade aprovada em `40f9cca` e qualidade em `a71390d`. Os dois arquivos PostgreSQL passaram independentemente: 52 testes, um worker, incluindo concorrência, rollback de efeitos, colisões de hash, escopo e adoção. Typecheck da API aprovado. Esse store ainda não está conectado aos escritores atuais; redutores de ações, conversão dos índices e histórico agregado permanecem pendentes. A serialização por workspace precisa passar pelo teste de carga da implementação final.

## Continuação 02/10/2026 (branch `claude/waha-rabbit-continuation`, base `fe08f9e`)

O diretório de trabalho anterior (`/private/tmp/prymeira-talk-waha-rabbit-clean-20260930`) não existia mais; o trabalho não commitado da etapa 3A foi refeito a partir de `fe08f9e`, o último checkpoint qualificado. Ambiente local: PostgreSQL 16 e RabbitMQ 4.3 descartáveis em loopback (portas e bancos exigidos pelas travas dos testes), ffmpeg e Poppler reais.

Estado verificado em `d7d6295`: API 2.457 testes (155 arquivos) aprovados em duas rodadas completas com PostgreSQL, RabbitMQ e executáveis compilados; web 418; shared 80; typecheck dos três pacotes. O `testTimeout` do vitest foi elevado (5 s -> 20 s) porque dois testes preexistentes estouravam 5 s apenas na execução paralela completa e passavam isolados.

- **Ciclo de vida dos efeitos** (migração `20261002120000`): `ingress_effects` ganha tentativas, lease, próxima tentativa, erro e resultado; o trigger que proibia qualquer UPDATE foi trocado por uma guarda que mantém imutáveis identidade, causa e entradas congeladas e torna `done` final. Executor com `FOR UPDATE SKIP LOCKED`, dependências entre efeitos da mesma mensagem (o dependente espera um estado terminal), recuperação de lease expirado, descarte do resultado de quem perdeu o lease e `requeue` de operador sem duplicar o efeito.
- **Mídia durável** (`message_media`): original e derivado de áudio no armazenamento privado, só referências e SHA-256 no SQL; limite de 25 MiB ao servir, 8 MiB ao processar; tipo sondado quando o provedor não informa; limite excedido e tipo não suportado ficam explícitos e recuperáveis; derivado que falha não repete a busca no provedor. WAHA usa a busca exata autenticada e nunca a URL guardada; Evolution usa o endpoint base64.
- **Transcrição única** (migração `20261002130000`): um job por mensagem com lease e token de fencing, compartilhado entre agente, botão manual e assistente; o texto continua em `messages.body` e `metadata.transcription` marca a conclusão sem mudar o tipo da mensagem.
- **Leitura pela IA**: agente (áudio, imagem, PDF) e assistente leem a cópia durável com os limites do chamador; sem cópia, caem no caminho antigo.
- **Ativação**: `TALK_MEDIA_STORE_PATH` (diretório privado absoluto). Sem a variável nada muda. O webhook legado da Evolution já grava a cópia (melhor esforço) e o worker de ingresso executa `media.prepare`.

Limites conhecidos: nenhum webhook produtivo foi redirecionado; os demais efeitos (`agent.debounce`, `assistant.message`, `prospecting.inbound`, `automation.occurrence`, `followup.activity`, `triage.message`, `handoff.brief`, `human_reply.improvement`, `history.backfill`, `assistant.control`, realtime e `content.reconcile`) continuam obrigações pendentes sem handler; o runtime de ingresso segue travado a PostgreSQL/RabbitMQ de teste; o diretório de mídia precisa existir com permissão 0700 do usuário do processo; a cópia em `message_media` convive com o base64 já salvo em `messages.media_url` (nada foi removido); homologação com WAHA/Evolution reais e testes de carga não foram feitos.

### Checkpoint 02/10/2026 (tarde): handlers, roteador de saída, saúde e estágio de produção (`0fe863e`..`282c17c`)

- **`0fe863e`**: handlers para os efeitos durários antes pendentes, realtime entre processos e loop de efeitos na API e no worker.
- **`4fa1ae6`**: roteador único de saída (`OUTBOUND_ROUTER_ENABLED`, desligado = comportamento atual). Journal `outbound_dispatches` (migração aditiva), failover só quando o envio provadamente não saiu, tentativa incerta retida para revisão e nunca reenviada, voz WAHA como voz.
- **`4778196`**: monitor de saúde (`CHANNEL_HEALTH_MONITOR_ENABLED`, desligado por padrão): probes de 15 s, falha na 3ª, "conectado mas sem receber" por 3 mensagens vistas só pela outra conexão, retorno à Evolution após 10 min saudáveis; painel de envios em revisão nos Canais.
- **`282c17c`**: estágio `production` do ingresso/worker com guardas próprias (banco não `*_test`, vhost Rabbit dedicado, namespace `talk.prod.*`, segredos >= 16 caracteres, escopo de workspace explícito); sessões WAHA registram o webhook assinado.

Verificação nesta retomada (container novo, sem PostgreSQL/RabbitMQ em execução): `pnpm typecheck` aprovado nos três pacotes; testes sem banco: API 1.921 aprovados (634 condicionais não executados), web 422, shared 80. Os testes PostgreSQL/Rabbit desses commits foram executados pela sessão anterior e **não** foram reexecutados aqui. Pendentes: 2a.3C/D (conversão dos remetentes/entradas/importadores/leitores), 2a-resolução, 2b.1D e o bloco 5 (infra, carga, homologação real).

### 2a.3D parcial: importador de histórico canônico (opt-in)

`CANONICAL_HISTORY_IMPORT_ENABLED=true` (padrão `false`) faz o importador de histórico (`channel-history-import.ts`, inclusive o `history.backfill` por conversa) gravar pelo store canônico em vez de `message.createMany`. Cada registro vira um evento `messages.upsert` normalizado em modo `history` e é persistido em uma transação READ COMMITTED própria (`channel-history-canonical.ts`): identidade exata, aliases PN/LID e deduplicação contra mensagens ao vivo vêm do store; histórico não gera efeitos operacionais, não soma não lidas e a conversa nova nasce `human_controlled`. Prévia e `lastMessageAt` só avançam. Mensagens que um escritor legado já possui (`providerMessageId`) são puladas, pois o store as seguraria como "requer adoção". Canal sem conexão Evolution ociosa (geração par) continua no escritor legado; fonte obsoleta reprograma a tentativa (`HISTORY_SOURCE_STALE`). Desligado, nada muda. Cobertura: `channel-history-canonical.postgres.test.ts` (5 cenários com PostgreSQL real) e `env.test.ts`. O webhook legado da Evolution (`evolution.routes.ts`) e os leitores continuam pendentes.

### 2a.3D: webhooks legados não são reescritos; trava de cutover

Decisão: `evolution.routes.ts` (webhook legado da Evolution) e `meta.webhooks.routes.ts` **não** foram convertidos linha a linha. O ingresso independente (HTTP -> RabbitMQ -> worker -> store canônico, com os mesmos hooks e efeitos) é o substituto; a conversão é o cutover de configuração (apontar o webhook para o ingresso), que pertence ao bloco 5. As rotas legadas permanecem intactas como caminho de rollback.

Para o cutover não duplicar nem perder eventos, `LEGACY_WEBHOOK_DELEGATED_WORKSPACES` (ids separados por vírgula ou `*`; padrão vazio = nada muda) faz as duas rotas legadas responderem `409 delegated_to_ingress` para esses workspaces, com log de aviso, sem gravar nada. A autenticação continua antes (segredo/assinatura inválida segue 401). 409 em vez de 200 é deliberado: um webhook ainda apontado para a rota antiga falha de forma visível em vez de sumir em silêncio. Ordem de cutover: ingresso e worker no ar com `TALK_MEDIA_STORE_PATH` e `EFFECTS_ENABLED`, webhook do provedor apontado para o ingresso, só então listar o workspace aqui. Testes: `evolution.routes.test.ts`, `meta.webhooks.routes.test.ts`, `env.test.ts`.

### 2a-resolução: autoridade operacional de conversas duplicadas

Quando PN e LID comprovadamente são a mesma pessoa e já existem duas conversas (um contato com telefone, outro com `@lid`), o chat canônico fica em `review` (`multiple_conversation_authorities`) e as mensagens novas ficam retidas. Agora um dono ou gerente resolve explicitamente em Canais > "Conversas duplicadas" (`GET /channels/conversation-authority`, `POST /channels/conversation-authority/:chatId/resolve`).

- **Nada é unido nem apagado**: as duas conversas mantêm UUIDs, configurações e histórico (os membros do chat canônico continuam lendo juntos). A escolhida passa a operar o chat; mensagens novas de qualquer grafia (PN ou LID) entram nela.
- **Decisão persistida** em `canonical_chat_authority_resolutions` (migração aditiva `20261002150000`), válida apenas enquanto os reivindicantes forem exatamente os do momento da escolha: um terceiro contato do mesmo número devolve o chat para revisão.
- **Recusas**: conversa que não é membro, envio com resultado desconhecido no chat (`dispatching/accepted_unbound/uncertain/review`), envio de prospecção sem confirmação em outra conversa e mapeamento de endereço em conflito.
- **A(s) conversa(s) aposentada(s) param de agir sozinhas**: controle humano, sessão de agente fechada, resposta pendente cancelada, follow-ups cancelados e rascunho do assistente obsoleto. Nenhuma linha é removida.
- **Mensagens retidas por falta de decisão** são reaplicadas na mesma transação como história conservada (sem agentes, automações nem não lidas; prévia e atividade só avançam). As linhas de progresso do ingresso são fatos imutáveis e permanecem como estavam; a observação canônica aplicada é a prova da recuperação.

Cobertura: `conversation-authority.postgres.test.ts` (3 cenários com PostgreSQL), rotas e painel (`conversation-authority.routes.test.ts`, `ConversationAuthorityPanel.test.tsx`).

## Critérios de publicação pendentes

Checkpoint canônico integrado aprovado em `117fd9f`: redutores persistentes de edições, exclusões, recibos, certificados e snapshots, com proteção cumulativa dos metadados entre páginas. Conformidade e qualidade independentes encerraram os achados de aliases após união PN/LID, fronteira de recuperação, recibos conflitantes e metadados incompatíveis. Os 164 testes canônicos com PostgreSQL passaram; a última revisão de qualidade executou 33 casos focados e quatro reproduções independentes. As consultas e escritores atuais ainda serão convertidos: essa aprovação não ativa a deduplicação em produção.

A versão de desempenho `72bbb639e34f90e33d1a247c9e6350f3c8c8d30c`, publicada pela outra frente, foi incorporada aditivamente em `e25dfec`. Nesse commit combinado, passaram 1.960 testes da API com todos os testes PostgreSQL condicionais habilitados, 418 da web e 80 compartilhados, além de typecheck, geração/validação Prisma e builds de produção. As correções posteriores de reconciliação não alteraram os arquivos de desempenho nem o schema; tiveram verificação canônica focada e typecheck. Não houve rollout desta integração.

As 50 migrações do checkpoint `11bc675` foram verificadas a partir do Git imutável em dois bancos novos próprios da tarefa: instalação limpa e atualização de fixtures legadas. Checksums e ledger foram conferidos; UUIDs, colunas originais, FKs, configurações, remetente de grupo e namespace Meta foram preservados. Os índices globais antigos permanecem presentes até a conversão completa dos chamadores.

Bloco 2a.3A aprovado em `bd49f12`: fronteira READ COMMITTED com advisory de workspace antes de leituras e autorização, validação da fonte física/configuração Meta ativa, referências exatas com autorização da origem, consultas/mídia exatas dos provedores e apresentação histórica restrita. As revisões encerraram corridas que liam aliases antes do lock, arquivos WAHA de outra sessão/mensagem e respostas históricas de grupo com remetentes contraditórios, inclusive respostas mistas da mesma chave. SPEC final: 87 testes e nove operações adversariais; QUALITY final: 360 testes em dez arquivos, typecheck, 33 operações adversariais e seis verificações PostgreSQL próprias. Estes APIs permanecem desconectados dos escritores produtivos; não houve ativação ou nova migração neste bloco.

Sondas isoladas do protocolo AMQP no RabbitMQ local 4.3.6, usando amqplib 2.2.0, confirmaram retorno obrigatório antes do confirm para publicação sem rota, reentrega após fechamento do consumidor, retry confirmado antes do ACK original, correlação de confirms concorrentes e backpressure sem republicação. Uma mensagem persistente confirmada sobreviveu ao reinício observado do processo com SIGTERM. Em outra execução, dez mensagens confirmadas sobreviveram ao encerramento abrupto com SIGKILL; cinco entregues sem ACK foram reentregues após reinício no mesmo diretório de dados. Somente processos e filas próprios de teste em loopback foram utilizados; as filas foram removidas ao encerrar cada sonda. Essas evidências não qualificam o percurso da aplicação, o broker 3.12.14 da VPS ou perda de energia do host.

Bloco 2a.3B aprovado em `63a0a8c`: intenções e tentativas persistentes, reserva do UUID antes de I/O, fences concretos dos domínios, resultados privados imutáveis, binding exato e retenção de ecos ambíguos. A coleção transacional integral de respostas, lookups autenticados e bindings preserva alternativas PN/LID e exige uma PN por família; uma resposta conveniente não pode ocultar outra contraditória. SPEC independente: 404 testes/14 arquivos; QUALITY: 396/11, dois repros próprios corrigidos, typecheck aprovado. As 53 migrações de `3562828` passaram em instalação limpa e atualização legada; source Prisma idêntico em `63a0a8c`, UUIDs/FKs/configurações preservados e índices antigos presentes. Permanece uma fundação desconectada: conversão dos produtores, RabbitMQ, mídia, IA e homologação não foram concluídos neste checkpoint.

A sessão do Portainer expirou durante a preparação em 01/10; o login humano foi solicitado para retomar o trabalho dependente do painel. Código e testes locais continuam independentemente desse acesso. Não foram recuperadas ou alteradas credenciais para contornar a expiração.

Transporte isolado 1A aprovado por SPEC e QUALITY em `464fee3`: ingresso e consumidor executáveis, validação sobre os bytes originais, receipts e arquivos privados imutáveis, publicação persistente obrigatoriamente roteada/confirmada, backpressure, retries/DLQ e recuperação limitada ao namespace autorizado. Encerramento de conexão silenciosa e cancelamento durante handshake/setup foram corrigidos e reproduzidos independentemente. Cada revisão executou 53 testes reais PostgreSQL/Rabbit; a SPEC também aprovou typecheck e build dos cinco entrypoints. As 54 migrações de `b134fa3` passaram instalação limpa/upgrade legado e o source Prisma permaneceu idêntico até o SHA aprovado. Os executáveis estão restritos mecanicamente ao ambiente local próprio. O consumidor grava `pending_application`, sem afirmar que Message ou efeitos foram aplicados. O ACK final após Message/trabalhos/efeitos atômicos pertence à integração seguinte; nenhum webhook produtivo foi redirecionado.

Durante geração da migração 54, o tooling usou incorretamente um banco local descartável do assistente como shadow. Fixtures locais foram perdidas; schema e ledger foram reconstituídos, sem alegar recuperação dos dados. A comparação posterior do schema completo com o banco próprio qualificado preservou funções, triggers, índices e FKs anteriores; dez testes de integração do assistente passaram na requalificação. Nenhum banco produtivo foi acessado ou alterado por esse incidente. Esse banco não será usado novamente como shadow.

Aplicação isolada 1B aprovada por SPEC e QUALITY em `2bfb0be`: o consumidor executável valida artifacts privados/source autenticada, aplica Message/redutores/hooks reais e conserva obrigações persistentes na mesma transação; ACK após application completa. Declarações conflitantes em participantes/chats/direções são conservadas antes de Message/efeitos, inclusive em raw de receipts normalizados antes da correção; PN/LID verificado e papéis de autor do alvo/ação permanecem separados. Prévia usa owner UUID privado, locks e invalidação de qualquer escrita legada de preview, inclusive valor igual, preservando clocks/visibilidade. SPEC independente: 260 testes/8 arquivos; QUALITY: 250/7, controles próprios de corrida, types/build/Prisma. Instalação limpa e upgrade em bancos próprios qualificaram 56 migrações do candidato, checksums/colunas/UUID/FK/config/grupos/Meta/autoridade preservados, sem owner legado inferido; FK de conversa incorreta bloqueada e trigger de invalidação comprovado. O teste compartilhado contém 56 migrações concluídas/distintas e uma tentativa histórica extra; nenhuma edição de ledger ou reset foi realizada. Handlers de efeitos, autoridade/importadores/readers, todos os remetentes, mídia/IA/saúde/realtime e infraestrutura continuam pendentes; executáveis seguem isolados e nenhum webhook produtivo foi redirecionado.

Arquivos sintéticos de imagem, áudio Opus/MP3, vídeo H.264/AAC, PDF, texto e um roteiro foram preparados na pasta de saídas da tarefa. Codecs, duração, hashes e PDF foram inspecionados localmente. Isso prepara a homologação; não comprova recebimento real, mensagem de voz, figurinha nativa ou entendimento pela IA.

- [ ] Migrações aditivas, backfill, isolamento por workspace e compatibilidade dos canais anteriores.
- [ ] Entradas simultâneas, reentrega, ACK/edição/exclusão fora de ordem, histórico e recuperação com checkpoints.
- [ ] Interrupção de API, workers, banco e broker; retomada de eventos aceitos e trabalhos pendentes.
- [ ] Mídia própria, limites, SSRF, autenticação, player, transcrição e compreensão pela IA.
- [ ] Todos os remetentes no roteador único; cadência, failover, eco e envios incertos sem duplicação.
- [ ] Duas conexões reais no mesmo número autorizado, QR independentes e rejeição de outro número.
- [ ] Inspeção visual e toda a matriz multimodal nas duas entradas.
- [ ] Carga de duas vezes o pico medido: ingresso p95 < 500 ms, mensagem no Talk <= 2 s após aceite, excluindo preparação de mídia/IA.
- [ ] Regressões de permissões, Meta, supervisão, campanhas, prospecção e controle humano.
- [ ] Medição de CPU/RAM por sessão WPP e capacidade restante da VPS antes de ampliar.
- [ ] Imagens imutáveis do mesmo commit, backup, migração compatível e verificação operacional da stack.

## Reversão

Desativar a redundância e escolher Evolution para novos envios, mantendo os processos compatíveis com a identidade canônica e o armazenamento próprio de mídia. Preservar canais, mensagens, aliases, observações, mídia e pendências; não executar migrações destrutivas. O retorno a uma API anterior à integração precisa de qualificação específica: seus lookups por ID de provedor e seu resolvedor de mídia não conhecem os novos contratos. Intenções com resultado incerto permanecem em revisão e não são reenviadas pelo rollback. Restaurar a imagem anterior da WAHA se necessário, mantendo os volumes e namespaces existentes. A reversão completa será validada com a implementação final.
