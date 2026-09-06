# Verificação do modo assistido

Data: 06/09/2026. Branch: `codex/assisted-inbox-pilot`. Execução sequencial, conforme escolha do usuário.

## Verificações concluídas

| Verificação | Resultado |
|---|---|
| API, incluindo PostgreSQL local | 769 testes aprovados em 58 arquivos |
| Contratos compartilhados | 51 testes aprovados |
| Interface | 111 testes aprovados |
| Typecheck dos 3 pacotes | Aprovado |
| Build da API | Aprovado |
| Build do web | Aprovado |
| Migrações desde banco vazio | 16 aplicadas somente no PostgreSQL descartável local |
| Prisma validate | Aprovado; avisos de relações SetNull já presentes no esquema anterior |

Total das suítes acima: 931 testes. Os 10 casos de banco fazem parte dos 769 da API, não foram contados duas vezes.

Banco isolado: `127.0.0.1:56439/assistant_pilot_test`, cluster temporário `/tmp/talk-assistant-pg.TcZRMT/data`. Não foi lido nem usado DATABASE_URL da VPS. Os testes só aceitam `ASSISTANT_TEST_DATABASE_URL` explícita, local e com esse nome descartável.

## Comandos

No diretório do projeto:

```sh
DATABASE_URL=postgresql://localhost:5432/unused pnpm --filter @prymeira-talk/api exec prisma validate --schema prisma/schema.prisma
ASSISTANT_TEST_DATABASE_URL=postgresql://yohannreimer@127.0.0.1:56439/assistant_pilot_test pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/shared test
pnpm --filter @prymeira-talk/web test
pnpm typecheck
pnpm --filter @prymeira-talk/api build:prod
pnpm --filter @prymeira-talk/web build
```

Sem a variável de teste, os casos de banco são explicitamente pulados; isso não constitui evidência de migração ou concorrência.

## Navegador

13 verificações de fluxo aprovadas em desktop (1440 × 940) e celular (390 × 844), sem erros de JavaScript: geração automática privada, ausência de envio autônomo, preservação do rascunho, revisão de contexto, autoria da edição enviada, tomada de controle durante geração, retomada, orientação privada, layouts, Escape/foco, envio direto aprovado e configuração do canal. O transporte local registrou exatamente 2 envios, ambos após aprovação explícita.

Capturas conferidas visualmente: `desktop.png`, `human-control.png`, `mobile-chat.png` e `mobile-panel.png`. `failure.png` registra a falha intermediária de rótulo do seletor, corrigida e retestada; não é a versão final.

`verify-browser.cjs` usa Playwright sobre o Vite e a API reais, banco local, autenticação validada contra uma implementação local de teste e destinos HTTP locais para provedor/transporte. Não usa o mockup HTML como prova de integração.

O helper Python da skill foi consultado. Como o ambiente já tinha Playwright em Node e não em Python, o teste utilizou a instalação Node disponível, sem acrescentar dependências ao projeto.

Para reproduzir, execute `apps/api/scripts/verify-assistant-local.ts` com `ASSISTANT_TEST_DATABASE_URL`, Vite em `127.0.0.1:56306` com `VITE_LOCAL_AUTH_BYPASS=true` e `VITE_API_URL=http://127.0.0.1:56440`, e então `verify-browser.cjs` com `PLAYWRIGHT_PACKAGE` apontando à instalação do Playwright. O harness só escuta loopback e não é incluído no build de produção.

Correções motivadas pela verificação: ordenação de mensagens no mesmo segundo; preservação de lease quando chega nova entrada; grade do chat no celular; rótulos acessíveis dos seletores; limpeza de revisões ao reiniciar conversa.

## Limites e avisos

- Build web aprovado com aviso de chunk principal acima de 500 kB (aprox. 959 kB antes de gzip). Otimização geral do bundle não foi incluída nesta mudança.
- Comparação somente de leitura do banco migrado com o schema não apontou diferenças nas novas tabelas/colunas. Apontou defaults de UUID em 8 tabelas legadas, que não foram alterados nem executados como SQL.
- Não houve chamada paga a modelo real ou mensagem enviada a telefone real nesta implementação.
- A qualidade das respostas e mídia no transporte real exige o checklist com chip/vendedor em `docs/assisted-inbox-pilot.md`.
- Provedor falhou: tentativa manual, sem fallback simulado. Envio incerto: não repetido automaticamente.
- Produção, migrações da VPS e canais permanecem sem alteração.
