# Publicação do modo assistido — 08/09/2026

Publicação autorizada pelo usuário no Portainer. Nenhum canal, vendedor, agente ou envio real foi ativado. Execução sequencial.

## Versão

- Código: `a6db129db6efb0bb2c23ae47d35edf7603c3b7d4`, branch `codex/assisted-inbox-pilot`.
- GitHub Actions: https://github.com/yohannreimer/Prymeira-talk/actions/runs/34228502634 — API e web concluídas com sucesso.
- Stack existente: `prymeiratalk`, id 68, ambiente 2.
- API: serviço `wseof97wna8dqec8jape6nshz`, tarefa `l58hrtas0qung8icqu34ywik0`.
- Web: serviço `4k2cr3628ku8j35o5w04jjn1x`, tarefa `06xcb10a9rw6t285q2jrfocnp`.
- Ambos usam a tag completa do commit. IDs de imagem exibidos pelo Portainer: API `sha256:5856d57c166746654576f9ae9b3ecc65670c0fa8e0cff30197d4b3568f42d1ae`; web `sha256:459f5915138b9fbf1f71db35459fcf7e7a0d4363caee920cabb3586cb3332d45`. São IDs locais das imagens, não necessariamente digests do manifesto multi-plataforma.

## Backup e banco

- Antes da migração: banco `prymeira_talk`, 14 migrações concluídas, aproximadamente 43 GB livres no volume do host.
- Backup custom do `pg_dump`: `/var/lib/postgresql/data/talk-deploy-backups/pre-assisted-20260908-a6db129.dump`, cerca de 94,7 MB, permissão 0600, no volume persistente `prymeiratalk_prymeira_talk_postgres`.
- SHA-256: `5608ac7813a84697db385396d79ab3384b613b881577dff6fbf577620311f985`.
- Verificação: `pg_restore --file=/dev/null` concluiu sem erro. Não foi executada restauração sobre produção. A cópia está na própria VPS; não substitui backup externo contra perda do host.
- Migração one-shot com a nova imagem, rede interna existente, sem portas públicas e sem iniciar o servidor: `pnpm migrate:deploy`.
- Stack auxiliar `prymeiratalk-migrate-a6db129`, id 75, serviço temporário `gfitol0y8xdukwdo9amzd4rka`. Logs confirmaram a aplicação de `20260906000100_assistant_drafts` e `20260906000200_assistant_message_order` e sucesso de todas as migrações. Depois da conferência, a stack auxiliar foi parada pelo Portainer; sua definição permanece guardada, sem serviço em execução.

## Verificação

- Nova execução local: 51 testes shared, 111 web, 759 API; os 10 testes PostgreSQL foram executados separadamente e aprovados. Total: 931.
- Typecheck dos três pacotes, build API, build web e `git diff --check` concluídos com sucesso. Permanece o aviso de tamanho do bundle web.
- API nova em execução, healthcheck `healthy`, zero falhas no momento da conferência.
- `/api/health` e `/api/ready`: HTTP 200, `{"ok":true,"product":"talk"}`.
- Rota privada `/api/assistant/conversations/...` sem autenticação: HTTP 401.
- Web entrega `index-Dt8g3Ja8.js` e `index-C2gLXIR7.css`, correspondentes ao build local verificado.
- Variáveis dos serviços comparadas em memória antes/depois: preservadas, sem gravar credenciais neste registro.
- Consulta somente de leitura no novo Prisma Client: 4 canais no banco; 0 com modo assistido ativado; 0 sugestões e 0 estados de fila.
- Talk autenticado abriu módulos Agentes, Canais e Atendimento. O espaço selecionado não contém canais/conversas disponíveis; portanto o painel de sugestões não foi exercitado sobre conversa real nesta publicação. Nenhum erro de console observado nessa navegação.
- O teste com chip, mídia real e vendedor permanece pendente, sob controle do usuário.

## Recuperação e próximos redeploys

As imagens anteriores foram preservadas:

- API: `ghcr.io/yohannreimer/prymeira-talk-api:7c900533d27d14485bfda447fb94708289326f47`; ID local `sha256:80b0b44ffb2204854e9d925d1f5d621914d13470ad98a860f371bc21e9e57305`.
- Web: `ghcr.io/yohannreimer/prymeira-talk-web:40b01c39a43eeb56da576938a1d757225c28d3cb`; ID local `sha256:109d2da87a55e9f316a142e1b252d22db6d771208d794c1ea8bfc2ded08debbd`.

A publicação trocou apenas as imagens dos dois serviços, preservando as demais configurações e o banco em execução. O editor da stack já estava desatualizado antes desta publicação, ainda apontando para `8a12a0c`. **Não usar “Update the stack” com aquele arquivo sem reconciliar imagens e parâmetros com os serviços atuais.** Este turno não reimplantou esse arquivo antigo nem reescreveu as variáveis da stack.

Não reverter para uma API anterior enquanto houver canais assistidos: o runtime antigo não conhece a trava de envio. As migrações são aditivas; não remover tabelas nem restaurar o backup sobre mensagens novas como procedimento automático de rollback.
