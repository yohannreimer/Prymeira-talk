# Evolution + WAHA e RabbitMQ — operação e qualificação

Este documento acompanha a integração. Inventário e testes observados são evidências; os critérios de publicação abaixo ainda precisam ser concluídos.

## Destino e inventário observado em 30/09/2026

Destino autorizado: VPS existente, gerida em `https://painel.yrdnegocios.com.br`, ambiente Portainer `primary` (endpoint 2).

- Swarm: um nó `srv1904129`, 2 CPUs e aproximadamente 8,3 GB de RAM. A indisponibilidade desse nó interrompe todos os serviços nele.
- Talk API e web: imagem do commit `0b7c213`, uma réplica de cada. PostgreSQL 16 existente.
- Broker a reutilizar: serviço `rabbitmq_rabbitmq`, imagem `rabbitmq:3.12.14-management-alpine`, uma réplica, persistência em `/var/lib/rabbitmq`, rede `network_swarm_public`, sem portas publicadas. Digest observado: `sha256:0b44fbcc3a4bf22d00090f1353127577dbe1fcb109c41669733a9d7ecf6c3a78`.
- Não utilizar o broker separado `operis_pluris_rabbitmq`.
- WAHA autorizada para reutilização: `deskcomm_waha`, uma réplica. Imagem atual `devlikeapro/waha:latest-2026.7.2`, digest `sha256:65e593e30bb702f891550b9da5d65e9e0eff8a926f5451fac6a582db84d3a323`, engine configurado `NOWEB`. Volumes existentes em `/app/.sessions` e `/app/.media` devem ser preservados.
- O inventário de metadados da sessão NOWEB persistida mostrou que seu proprietário difere do número autorizado para homologação. Isso não comprova o estado atual da conexão. Não adotar nem substituir essa sessão como sessão de teste do Talk.
- Evolution existente: `evoapicloud/evolution-api:2.4.0-rc2`. Esta integração não depende de atualizar sua versão.

O hostname `manager01` no exemplo antigo de stack não corresponde ao nó observado. A configuração efetiva do Portainer deve ser preservada ao atualizar a stack; não substituir variáveis e credenciais pelo conteúdo de um exemplo.

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

## Ambiente local de testes

PostgreSQL 16.14 e RabbitMQ 4.3.6 executados somente em loopback, em dados descartáveis próprios da tarefa. O protocolo usado deve ser compatível com AMQP 0-9-1 e o broker 3.12.14 da VPS. Repetir a qualificação no broker de produção usando um vhost de homologação isolado.

Evidências iniciais, antes da integração:

- Shared: 77 testes aprovados.
- Web: 299 testes aprovados.
- API: 1.536 aprovados, 78 condicionais não executados nesse primeiro comando.
- Banco real: 61 testes de campanhas, prospecção e supervisão aprovados em PostgreSQL local.
- Banco real: mais 17 testes de assistente e leads aprovados em bancos PostgreSQL locais separados, com as 39 migrações existentes nesse estágio.
- Listener AMQP local confirmado por `rabbitmq-diagnostics listeners`, em loopback.

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

Desativar a redundância e escolher Evolution para novos envios. Preservar canais, mensagens, aliases, observações, mídia e pendências; não executar migrações destrutivas. Intenções com resultado incerto permanecem em revisão e não são reenviadas pelo rollback. Restaurar a imagem anterior da WAHA se necessário, mantendo os volumes e namespaces existentes. A reversão completa será validada com a implementação final.
