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

NOWEB e WPP têm namespaces de sessão distintos. Preservar o volume original e manter `WAHA_SESSION_NAMESPACE` no default do engine; não reaproveitar arquivos de autenticação NOWEB como se fossem WPP. A mudança poderá exigir leitura de um novo QR Code. Conferir o inventário das sessões antes de alterar o serviço.

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

## Critérios de publicação pendentes

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
