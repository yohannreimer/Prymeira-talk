# Saúde dos canais: vigia e aviso visível — desenho

Data: 2026-10-02. Base: produção conhecida `72bbb63`. Branch: `codex/talk-channel-health-20261002`.

## Problema

Os canais Evolution caem e o Talk não reage: o status do canal é só o último `connection.update` recebido (`evolution.routes.ts`), nada o confere depois, o Talk não tenta reconectar e a única indicação é o selo na página Canais. Resultado observado: canais "conectados" que já não recebem mensagens, e vendedores sem saber que o número caiu.

Causas prováveis do status velho: webhook de queda perdido (deploy do Talk), webhook da instância deixou de apontar para o Talk (ele só é configurado ao criar/reconectar o canal), sessão travada na Evolution, evento recusado (404/400).

## Objetivos

1. Mostrar um aviso visível, em qualquer tela do Talk, quando um canal está caído, precisa de QR ou parece travado.
2. Um vigia no servidor que confere o estado real, corrige o status, reafirma o webhook, tenta reconectar quando a queda é recuperável e detecta silêncio suspeito.

## Decisões aprovadas

- Vigia a cada 120 s (configurável), com interruptor `CHANNEL_WATCHDOG_ENABLED` (padrão ligado) e `CHANNEL_WATCHDOG_INTERVAL_SECONDS`.
- Sem alteração de banco: o estado do vigia fica em memória e é publicado pelo realtime existente.
- Silêncio: alerta após 3 h sem receber mensagem, só de segunda a sábado, 8h–19h (America/Sao_Paulo), e só para canais que receberam algo nos últimos 7 dias.
- Reconexão com espera crescente (2, 5, 10, 30, 60 min) e no máximo 5 tentativas por queda; depois marca "precisa de QR".
- O aviso aparece no canto inferior direito, fixo e sobreposto (não altera o layout das telas), com botão que leva a Canais.

## Unidades

### Compartilhado (`packages/shared`)
- `channelHealthSchema` / `ChannelHealthDto`: `{ channelId, state: "ok" | "reconnecting" | "disconnected" | "needs_qr" | "silent", since, lastInboundAt, attempts }`.
- Novo evento realtime `channel.health` com payload `ChannelHealthDto`.

### `channel-health.ts` (API, funções puras)
- `decideChannelHealth({ evolutionState, previous, lastInboundAt, now })` devolve o novo estado, o status a gravar no Talk, se deve tentar reconectar e quando é a próxima tentativa.
- `isBusinessHours(now)` e constantes de espera/limite/silêncio.

### `channel-watchdog.ts` (API)
- A cada ciclo, para cada canal Evolution: lê o estado real (`getConnectionState`), decide, corrige o status do canal quando diverge (publica `channel.updated`), reafirma o webhook (no máximo a cada 15 min por canal), tenta reconectar (`connectInstance`) quando a decisão pede e marca `needs_qr` se a Evolution devolver QR. Publica `channel.health` quando o estado muda.
- Falha em um canal não afeta os demais. Evolution inalcançável: não altera nada.
- Expõe `getHealth(workspaceId)` para a rota.

### Rota
- `GET /channels/health` devolve `{ health: ChannelHealthDto[] }` do workspace (carga inicial do aviso).

### Web
- `describeChannelProblems(channels, health, now)` (puro) transforma canais + saúde em avisos.
- `ChannelHealthAlerts`: busca canais e saúde (mesmas chaves de cache da sessão), escuta `channel.updated` e `channel.health`, renderiza o aviso; montado em `TalkSuiteShell`.

## Erros e limites

- Evolution fora do ar: o vigia não muda status nem tenta reconectar.
- Nunca gera QR para exibir a todos: o QR continua sendo pedido pelo botão Reconectar da página Canais.
- Reconectar uma sessão que a Evolution devolve com QR significa aparelho desvinculado: o vigia para e avisa.
- Fora de escopo: causa raiz das quedas (logs da Evolution), notificação fora do Talk (e-mail/WhatsApp), canais Meta.

## Testes

- Decisão de saúde: aberto, conectando, fechado com e sem tentativas, limite, backoff, silêncio, horário comercial, Evolution inalcançável.
- Vigia: correção de status, webhook reafirmado e limitado, reconexão, QR, erros isolados, publicação só na mudança.
- Rota, esquema compartilhado, helper de avisos e componente do aviso.

## Entrega

Implementar na branch, rodar typecheck, testes e build; abrir PR em draft. Publicação só com autorização, com reversão para a imagem anterior e interruptor para desligar o vigia sem novo deploy.
