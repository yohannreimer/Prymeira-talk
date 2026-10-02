# Evolution + WAHA + RabbitMQ — rollout

Ordem de ativação, primeiro só com o número de teste do Yohann, depois para todos. Cada passo é reversível e **tudo é
desligado por padrão**: implantar a branch sem preencher as variáveis não muda o comportamento de hoje. Evidências e
limites do que já foi qualificado estão em `evolution-waha-rabbit.md`.

## 0. Antes de começar

- Backup do PostgreSQL do Talk. A branch traz migrações **aditivas** (tabelas e colunas novas; nada é removido ou
  reescrito) que rodam no deploy da API.
- Imagem imutável do commit: `Publish Docker images` > *Run workflow* nesta branch. Disparo manual publica só a tag
  `:<sha>` (não mexe em `latest`). Use `IMAGE_TAG=<sha>` nas duas stacks.
- Esta integração só deve ir ao ar depois de a frente de desempenho (PR #6) estar incorporada; ver `evolution-waha-rabbit.md`.
- Rodar os testes pesados de PostgreSQL/RabbitMQ numa máquina com mais CPU (neste container de 4 CPUs, 12 deles estouram o
  limite de 5 s de transação do Prisma; passam em máquina normal segundo o registro da sessão anterior).

## 1. RabbitMQ: vhost e usuário próprios do Talk

No serviço existente `rabbitmq_rabbitmq` (não usar `operis_pluris_rabbitmq`, não tocar nas filas atuais):

```sh
docker exec -it $(docker ps -q -f name=rabbitmq_rabbitmq) sh -c '
  rabbitmqctl add_vhost talk &&
  rabbitmqctl add_user talk "<senha forte>" &&
  rabbitmqctl set_permissions -p talk talk ".*" ".*" ".*"'
```

`TALK_AMQP_URL=amqp://talk:<senha>@rabbitmq_rabbitmq:5672/talk`. O ingresso recusa subir no vhost `/` ou sem usuário próprio.
Preservar o volume `rabbitmq_data`.

## 2. Stack principal (API/web) com os interruptores desligados

Atualizar `prymeira_talk` com `docker-compose.prod.yml` (cria o volume `prymeira_talk_media`; as variáveis novas entram vazias
ou `false`). Verificar `/api/health` e que a conversa, o envio e a Evolution continuam normais. Neste ponto nada mudou para o usuário.

## 3. Stack WAHA + ingresso + worker

Variáveis (Portainer): `WAHA_IMAGE` (já fixada por digest no compose; só trocar depois de qualificar outra versão), `WAHA_API_KEY`, `WAHA_WEBHOOK_HMAC_KEY` (>= 16
caracteres cada, valores distintos), `TALK_AMQP_URL`, `INGRESS_WORKSPACE_ALLOWLIST=<id do workspace de teste>` (**nunca `*`** no
primeiro teste), `EVOLUTION_WEBHOOK_SECRET` (o mesmo da stack principal), `INGRESS_EVOLUTION_ROUTE_RULE` vazio.

```sh
docker stack deploy --with-registry-auth -c docker-compose.waha-rabbit.prod.yml prymeira_talk_wa
```

Conferir: `ingress` saudável (`/health` responde `separate_canonical_worker_required`), `ingress_worker` sem erro de conexão, WAHA no ar
(`WHATSAPP_DEFAULT_ENGINE=WPP`; o sistema deve conferir versão/engine reais ao criar sessão). Os nomes das variáveis de ambiente da WAHA no compose seguem a documentação oficial, mas **o container não foi executado**: conferir o log de inicialização na primeira subida. A WAHA do Talk é nova e separada: volumes
`waha_sessions`/`waha_media` próprios, a `deskcomm_waha` não é tocada.

## 4. Entrada da Evolution pelo ingresso (só o workspace de teste)

**Antes de ligar a WAHA.** Enquanto a rota legada grava as mensagens da Evolution, uma mensagem que também chegasse pela WAHA (ou
por recuperação de lacunas) entraria pelo caminho novo e de novo pelo antigo: duas cópias. Por isso a Evolution passa primeiro
para o ingresso.

Na stack principal, nesta ordem (cada linha, um redeploy e uma conferência):

1. `REALTIME_BRIDGE_ENABLED=true` e `TALK_MEDIA_STORE_PATH=/data/media`.
2. `EFFECTS_ENABLED=true` com `EFFECTS_WORKSPACE_ALLOWLIST=<id do workspace de teste>`: a API passa a executar os efeitos duráveis
   (agente, assistente, follow-ups, triagem, automações, tempo real) **só** para esse workspace.
3. `CANONICAL_HISTORY_IMPORT_ENABLED=true`: o primeiro histórico (contatos e últimas conversas pela Evolution) passa pelo store canônico.

Depois, o corte. O webhook da Evolution continua apontando para a mesma URL pública `/webhooks/evolution/<workspace>`; o que muda é a
rota do Traefik. Definir a variável abaixo e fazer redeploy da stack WAHA. Só esse caminho vai ao ingresso (prioridade 1000); os outros
workspaces seguem na rota legada.

```text
INGRESS_EVOLUTION_ROUTE_RULE=Host(`talk.prymeiradigital.com.br`) && PathPrefix(`/webhooks/evolution/<id do workspace de teste>`)
```

Na stack principal, `LEGACY_WEBHOOK_DELEGATED_WORKSPACES=<id do workspace de teste>`: se algum webhook ainda chegar à rota legada para esse
workspace, ela responde 409 e registra aviso, em vez de gravar em duplicidade ou sumir em silêncio. Conferir que mensagens continuam
chegando no Talk.

## 5. WAHA, roteador, saúde e recuperação

1. Stack principal: `WAHA_ENABLED=true`, `WAHA_API_BASE_URL=http://waha:3000`, `WAHA_API_KEY`, `WAHA_WEBHOOK_BASE_URL=http://ingress:4011`,
   `WAHA_WEBHOOK_HMAC_KEY` (igual ao da stack WAHA). A tela de Canais passa a oferecer "Gerar outro QR Code — WAHA".
2. Stack principal: `OUTBOUND_ROUTER_ENABLED=true` (roteador único de saída, journal, failover e envio incerto em revisão).
3. Stack principal: `CHANNEL_HEALTH_MONITOR_ENABLED=true` (probes de 15 s, "conectado mas sem receber", troca de conexão de envio).
4. Stack WAHA: `WAHA_HISTORY_IMPORT_ENABLED=true`. Depois que a Evolution termina o primeiro histórico e a WAHA é comprovada no mesmo
   número, a WAHA lê os mesmos 15 dias (30 mensagens por conversa) e acrescenta só o que a Evolution não trouxe. Conversas que a WAHA
   conhece só pelo LID ficam de fora (sem prova do telefone, criariam conversa duplicada).
5. Stack WAHA: `INGRESS_RECOVERY_ENABLED=true`. A cada 5 min, cada conexão relê o que o provedor tem desde o último checkpoint (com 10 min
   de sobreposição, deixando de fora os últimos 30 s) e reconcilia: o que já chegou é duplicata; o que faltou entra como não lida, sem
   agente nem automação. O checkpoint só avança depois de a janela inteira ser reconciliada.
6. Com as duas conexões conectadas, usar Canais > "Comparar histórico" para ver, nas conversas recentes, o que cada engine devolve
   (nas duas, só Evolution, só WAHA). Só lê. Se uma for claramente mais completa, a ordem pode ser invertida.

## 6. Teste com o número do Yohann

Marcar apenas depois de observado (não há homologação real registrada até aqui):

- [ ] Evolution conectada pelo QR; estado "1/2". Mensagem recebida no Talk em até 2 s após o aceite; uma só mensagem, uma só não lida.
- [ ] "Gerar outro QR Code — WAHA" com **o mesmo número**; estado "2/2". Escanear com outro número deve ser recusado.
- [ ] Mesma mensagem observada pelas duas conexões gera uma única mensagem e um único acionamento (agente/automação).
- [ ] Texto, áudio (player, velocidade, transcrição), imagem (legenda/ampliação), figurinha, vídeo, PDF, contato e localização, nas duas entradas.
- [ ] Enviar do Talk: sai por uma conexão só; voz sai como voz; eco da outra conexão não duplica.
- [ ] Derrubar a sessão ativa: o envio troca de conexão sozinho; envio sem confirmação aparece em Canais > "Envios em revisão" e **não** é reenviado.
- [ ] Contato que existe como telefone e como LID: fica uma só conversa (a do telefone), com o histórico das duas; mensagens retidas entram. O painel "Conversas duplicadas" só aparece para casos que o Talk não decidiu sozinho.
- [ ] Primeiro histórico: contatos e últimas conversas pela Evolution; a WAHA completa sem duplicar. Comparar histórico e anotar o resultado.
- [ ] Desligar o webhook por alguns minutos (ou parar o ingresso) e religar: a recuperação de lacunas traz o que faltou, sem duplicar.
- [ ] Editar e apagar mensagens, recibos de leitura, histórico importado sem acionar IA.
- [ ] Reiniciar API, worker, ingresso e banco no meio do tráfego: nada aceito se perde nem duplica.
- [ ] Carga: pelo menos 8 mensagens/s canônicas (16 envelopes/s), ingresso p95 < 500 ms; registrar CPU/RAM por sessão WPP.

## 7. Para todos

Somente depois de a lista acima passar: `INGRESS_WORKSPACE_ALLOWLIST=*`, `EFFECTS_WORKSPACE_ALLOWLIST` vazio (todos),
`LEGACY_WEBHOOK_DELEGATED_WORKSPACES=*` e a regra do Traefik sem o id do workspace:

```text
INGRESS_EVOLUTION_ROUTE_RULE=Host(`talk.prymeiradigital.com.br`) && PathPrefix(`/webhooks/evolution`)
```

Um workspace de cada vez é preferível a "todos" de uma vez. Para cada workspace, entrar na `INGRESS_WORKSPACE_ALLOWLIST` **no mesmo redeploy** em que a regra do Traefik passa a levá-lo ao ingresso e ele entra em `LEGACY_WEBHOOK_DELEGATED_WORKSPACES`: com a recuperação e o histórico da WAHA ligados, um workspace na allowlist cuja Evolution ainda grava pela rota legada poderia receber cópias.

## Reversão

- Corte da entrada: esvaziar `INGRESS_EVOLUTION_ROUTE_RULE` e `LEGACY_WEBHOOK_DELEGATED_WORKSPACES` e redeploy; a rota legada volta a gravar.
  Eventos já aceitos pelo ingresso continuam no banco; mensagens que a rota legada já possui não são duplicadas (o store segura como "requer adoção").
- Desligar `OUTBOUND_ROUTER_ENABLED`, `CHANNEL_HEALTH_MONITOR_ENABLED`, `EFFECTS_ENABLED` e `CANONICAL_HISTORY_IMPORT_ENABLED` devolve cada parte ao comportamento anterior.
- **Antes** de esvaziar a regra do Traefik, desligar `INGRESS_RECOVERY_ENABLED` e `WAHA_HISTORY_IMPORT_ENABLED` (e, se for voltar só para a Evolution, desconectar a WAHA): com a rota legada gravando de novo, cópias recuperadas pelo caminho novo poderiam duplicar.
- Não executar migrações destrutivas. Envios incertos permanecem em revisão e não são reenviados pelo rollback.
- Voltar a imagem da API anterior exige qualificação própria (os lookups antigos não conhecem os novos contratos); ver a seção de reversão em `evolution-waha-rabbit.md`.
