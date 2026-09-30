# Atendimento e navegação — desempenho em 30/09/2026

Base verificada: `4524fbb3e834197626d7fc6ad329a7282c562615`. Checkout completo fora do iCloud, `git fsck --full` aprovado. O código de produção observado, `0b7c21391cd961514e28d475ae391f3b2b97ade2`, é idêntico à base nas aplicações; a diferença até a base contém somente documentação.

## Dados durante a sessão

TanStack Query v5 é compartilhado acima dos módulos. A fronteira autenticada separa sessão, usuário e workspace, e descarta consultas, rascunhos, seleção, recursos e WebSocket ao encerrar ou revogar o acesso. Não há histórico persistente nem funcionamento offline.

Lista, mensagens e contexto têm validade de 15 segundos; catálogos, cinco minutos. Históricos ficam limitados a 30 conversas e 100 mensagens por conversa, com coleta após dez minutos de inatividade. A conversa aberta é protegida do descarte; rascunhos e rolagem sobrevivem ao descarte de seu histórico. Reaberturas mostram cache imediatamente, inclusive durante atualização ou falha de rede.

O shell continua montado e os módulos são carregados sob demanda, com antecipação ao foco ou hover da navegação. A antecipação de mensagens exige apontar uma conversa por 150 ms, aceita duas leituras concorrentes e não chama marcação de leitura, processamento de IA ou envio.

Há uma conexão de eventos por sessão, com token renovado antes das tentativas de conexão. Ela atualiza também históricos não abertos, preserva recibos mais recentes e reaplica eventos que chegaram durante uma leitura HTTP. Invalidações sem informações suficientes no DTO são agrupadas. Retorno à janela e reconexão reconciliam dados sem apagar o conteúdo disponível.

Fotos e mídia compartilham até 64 MiB em memória. URLs de objetos são liberadas no descarte; imagens continuam dependentes de visibilidade e áudio/vídeo carregam sob demanda. Lista, histórico e painel auxiliar são isolados da digitação no compositor. A rolagem da lista e de cada histórico é restaurada; a atualização da lista preserva a extensão das páginas já abertas.

## Prazo de leitura e autorização

Leituras do Atendimento incluem obtenção de token, transporte e leitura do corpo dentro de um prazo total de oito segundos. Trocas de conversa cancelam leituras substituídas. Operações de escrita e leituras que processam IA não recebem repetição automática.

A API reúne somente validações de acesso simultâneas para a mesma combinação token/produto/Hub. O prazo do Hub é de três segundos, inclusive se o corpo da resposta travar. A entrada desaparece ao concluir: nenhuma decisão de autorização permanece em cache entre chamadas. As regras de supervisão continuam separadas.

As leituras de lista, mensagens, contexto e contagem usam `Cache-Control: private, no-store`. `Server-Timing` e logs agregados distinguem `hub`, `db_wait`, `assembly`, `serialize` e `total`. `db_wait` mede a espera da operação Prisma, incluindo pool/transporte/decodificação; `databaseOperations` conta operações Prisma, não instruções SQL físicas. Os logs não incluem conteúdo, identificadores de clientes ou credenciais.

Recusas locais de permissão não encerram a sessão. Uma recusa de acesso ao produto/workspace ou confirmação pela fronteira `/me` descarta a sessão; erros transitórios do Hub mantêm os dados disponíveis e permitem recuperação. Falhas de envio ficam vinculadas à conversa e à tentativa de origem, inclusive ao sair do módulo. A conferência manual do histórico não repete o POST e não apaga falhas de envios posteriores.

## Evidência de desempenho

Comparação de builds de produção, mesmo navegador, 40 conversas sintéticas, 100 mensagens de texto por conversa e respostas da API com atraso fixo de 180 ms. Cada amostra espera o conteúdo do histórico correspondente e dois frames; esconder o spinner não encerra a medição.

| Cenário | Amostras | p95 anterior | p95 otimizado |
| --- | ---: | ---: | ---: |
| Primeira abertura do histórico | 30 | 230,4 ms | 212,4 ms |
| Reabertura do histórico | 30 | 227,7 ms | 29,4 ms |
| Retorno ao Atendimento | 30 | não medido | 33,3 ms |

Medição final do código `2631da1d98e97c1768a19bf954906bc58d4e7eee`. No observador usado na comparação, p95 do cabeçalho foi 8,0 ms nas primeiras aberturas e 15,5 ms nas reaberturas. O painel opcional confirmou 30 ausências e 30 acertos de cache, sem cancelamentos; seus p95 após dois frames foram 29,3 ms para o cabeçalho inicial, 211,7 ms para histórico sem cache, 28,8 ms com cache e 33,1 ms para retorno. O rascunho e a seleção foram preservados nos 30 retornos.

Não ocorreram tarefas longas nessas amostras. O socket compartilhado abriu uma conexão; o build anterior abriu duas. As reaberturas com cache vencido ainda reconciliam em segundo plano; a melhoria não depende de eliminar essa consulta.

O arquivo inicial JavaScript passou de 1.597,89 kB (gzip 472,05 kB) para 516,23 kB (gzip 146,34 kB), `index-DqhIzZ-l.js`. Atendimento tem 506,41 kB (gzip 159,79 kB), `InboxPage-BUIjuIfA.js`; os demais módulos também têm arquivos separados. O Vite continua emitindo o aviso de arquivos acima de 500 kB; as metas de interação foram medidas separadamente.

Essas medições isolam comportamento do navegador; não são percentis da rede ou da sessão autenticada de produção. Download de anexos e processamento da IA ficam fora da medição de abertura.

Consultas representativas no PostgreSQL de produção, somente leitura e com timeout de dois segundos: lista limitada a 50, execução 0,848 ms; histórico limitado a 100, execução 0,219 ms; notas do contexto limitadas a cinco, execução 0,114 ms. São amostras únicas das projeções principais, sem as relações do Prisma, autorização ou transporte. Nenhuma migration ou índice foi adicionado.

Validação automatizada: 1.621 testes da API em 128 arquivos com PostgreSQL; 391 testes web em 55 arquivos; 77 testes shared em sete arquivos. Instalação congelada com pnpm 10.0.0, typecheck e builds passaram. A suíte web final usou dois workers; uma rodada anterior concorrente com build teve timeout de teste e a repetição integral passou sem aumentar seu prazo. Regressões exercitam respostas HTTP antigas, eventos até o commit no cache, cancelamento, paginação, isolamento, revogação e dois envios manuais idênticos de texto/anexo com confirmações independentes.

## Homologação autenticada

Abrir o aplicativo com `?talkPerf=1` habilita um painel de diagnóstico opcional. O painel registra somente contagens e tempos numéricos em memória: cabeçalho, histórico correspondente após dois frames, acertos/ausências de cache, cancelamentos, retorno ao Atendimento, recursos e tarefas longas. Não envia telemetria, identifica clientes nem persiste amostras. A URL normal não exibe o painel nem instala observadores de desempenho.

Comparar pelo menos 30 primeiras aberturas e 30 reaberturas, zerando os números entre as séries sem encerrar a sessão. Conferir conteúdo do alvo, troca rápida A → B → A, filtros, rascunhos com anexos, rolagem, timeout com recuperação, reconexão, foco, mídias e isolamento/revogação. Metas p95: cabeçalho ≤100 ms; cache e retorno ≤200 ms; ausência de cache ≤1 s em rede estável. O prazo das leituras é ≤8 s. Abertura exclui download de anexos e IA.

A validação não envolve enviar mensagens para clientes. Testes de envio incerto, recibos e controle humano usam transportes simulados e os testes existentes de API; entrega de uma mídia nova exige um destinatário de teste autorizado.

## Publicação e compatibilidade

Construir API e web do mesmo commit e conferir as imagens efetivamente ativas antes de atualizar os serviços. Preservar imagens anteriores e configurações existentes. Não reaplicar o editor antigo da stack. Esta entrega não altera provedores, ingresso RabbitMQ, persistência de mídia ou roteamento de envio.

Ao integrar WAHA/RabbitMQ, manter os IDs internos e contratos de eventos usados pelas consultas. Incorporar mudanças aditivamente, sem substituir arquivos pelo conteúdo de uma branch antiga. Repetir a homologação de reconexão, mídias, recibos, controle humano, envio incerto e revogação nessa combinação.

Referências das APIs usadas: [TanStack Query v5: cache](https://tanstack.com/query/latest/docs/framework/react/guides/caching) e [React.lazy](https://react.dev/reference/react/lazy).
