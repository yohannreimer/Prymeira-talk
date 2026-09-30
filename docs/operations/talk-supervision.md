# Supervisão de vendedores

O supervisor entra no Talk pelo Hub usando `?module=supervisao`. A tela consulta contas existentes e não conecta outro WhatsApp. O administrador da Prymeira vincula supervisor, vendedor, workspace e canal no Hub. Cada canal mantém o vendedor indicado no vínculo, independentemente de quem aparece como responsável por uma conversa.

## Autorizações

Cada requisição `GET /supervision/*` consulta `GET /me/talk-supervision` no Hub com o bearer atual, sem cache e com timeout. O Hub revalida o acesso ativo do vendedor ao Talk e retorna somente vínculos elegíveis. Não há fallback para permissões locais, impersonação, membership ou papel administrativo do vendedor. Rotas comuns continuam exigindo a autorização comum do produto.

O catálogo `GET /supervision/admin/channels?workspaceId=UUID` exige confirmação administrativa em `/admin/session` do Hub. O Hub valida a origem selecionada e confirma o canal neste catálogo antes de salvar o vínculo. Vínculos e revogações têm auditoria no Hub.

## Consultas

- `GET /supervision/summary?unreadPeriod=all|24h|7d`: totais completos por vendedor de próximas ações e conversas não lidas na fila ativa e visível, sem limite de 50. O período afeta somente não lidas.
- `GET /supervision/conversations`: filtros independentes `sellerCustomerId`, `status=active|closed|all`, `nextAction=true|false`, `unread=true|false`, `unreadPeriod=all|24h|7d`, `cursor`. Retorna `conversations` e `nextCursor`, com até 50 registros por página. O período só restringe a lista quando `unread=true`.
- `GET /supervision/workspaces/:workspaceId/conversations/:conversationId/messages`: conversa identificada pelo vendedor e número, com histórico. Não marca leitura, importa histórico, reconhece alertas, agenda IA ou escreve notas.
- No mesmo caminho, `messages/:messageId/media` e `messages/:messageId/preview?page=N` permitem consulta a anexos e PDF. Cada acesso valida o canal autorizado antes de acessar mídia em cache.

As regras existentes de próxima ação e não lidas são compartilhadas com o atendimento. `handoffActionCompletedAt` representa a conclusão; abrir uma conversa não conclui uma ação. A supervisão não cria um indicador alternativo de mensagens sem resposta nem contadores de follow-up. Reservas internas de follow-up não aparecem no histórico, seguindo a regra existente.

A interface usa **últimas 24 horas** inicialmente para o indicador de não lidas, com opções de últimos 7 dias e todo o período. São janelas móveis de 24 ou 168 horas. Uma conversa precisa continuar não lida pela regra atual e ter recebido uma mensagem do cliente dentro da janela. A data original da mensagem determina o período; importar um histórico antigo ou enviar uma resposta recente não torna a não lida antiga recente. Datas futuras ficam fora das janelas. Sem `unreadPeriod`, os endpoints mantêm a consulta a todo o período para compatibilidade.

Clicar no nome do vendedor abre todas as suas conversas visíveis, incluindo lidas e encerradas, e desativa os filtros de próxima ação e não lidas. O histórico apresenta datas e horários completos das mensagens recebidas e enviadas, sem marcar leitura nem gerar um cálculo novo de tempo de resposta. As próximas ações continuam disponíveis independentemente da idade.

A continuação preserva a chave de ordenação original, incluindo timestamps e ID, e verifica o par workspace/canal nos vínculos atuais. A chegada de uma mensagem ao último item da página anterior não desloca o cursor. Filtros e escopo são aplicados no banco, inclusive quando há canais de vários workspaces.

## Publicação e configuração

1. Aplicar a migração de supervisão do Hub e publicar a Account API com as novas rotas.
2. Publicar a API do Talk com o catálogo e as consultas de supervisão; não há nova migração no Talk.
3. Publicar as interfaces do Hub e Talk. Configurar `TALK_API_URL` no Hub caso a base da API seja diferente da origem do produto seguida de `/api`. Configurar `VITE_PRYMEIRA_HUB_URL` no web do Talk com a URL pública do Hub para o link de retorno.
4. No Hub, selecionar o supervisor existente; adicionar cada vendedor, seu workspace elegível e o número correto. Atribuir apenas os canais deste cliente.
5. Entrar como supervisor; conferir os cinco vendedores, filtros combinados, leitura sem efeitos e remoção de uma próxima ação concluída pelo vendedor. Revogar um vínculo e conferir que a próxima consulta bloqueia o canal.

Falhas do Hub bloqueiam as novas consultas. Alterações de canal/conta exigem atualização explícita do vínculo. Os fluxos atuais dos vendedores permanecem independentes.

## Verificação local

Os testes opt-in de PostgreSQL exigem um banco descartável cujo nome termine em `_test`, com as migrações do Talk aplicadas:

```sh
SUPERVISION_TEST_DATABASE_URL=postgresql://usuario@localhost:5432/talk_supervision_test pnpm --filter @prymeira-talk/api exec vitest run src/modules/supervision
pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/web test
pnpm typecheck
pnpm --filter @prymeira-talk/web build
```

Também foi validado um percurso local com as APIs reais do Hub e Talk, em bancos descartáveis: cinco vendedores, 75 próximas ações, páginas de 50 e 25 registros, leitura preservada e revogação bloqueando imediatamente a consulta seguinte.

A suíte completa da API do Talk passou com os testes de PostgreSQL habilitados: 1.504 testes aprovados. O web do Talk passou em 270 testes, incluindo a preservação de páginas carregadas e revogação parcial nas duas ordens de resposta. Também passaram os testes do pacote compartilhado, as suítes do Hub e quatro testes adicionais do Hub contra PostgreSQL, além dos typechecks e builds web dos dois projetos. Os bancos e contas usados nessa validação são descartáveis; a publicação e os vínculos do cliente real seguem os passos acima.
