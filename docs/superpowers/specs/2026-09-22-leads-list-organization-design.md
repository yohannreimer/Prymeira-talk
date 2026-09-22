# Organização e exclusão das listas de Leads

## Objetivo

Manter a coluna “Minhas listas” curta durante o uso normal e permitir remover buscas de teste sem perder acesso às listas antigas. O padrão aprovado é mostrar as três listas mais recentes, oferecer “Ver todas” e permitir excluir uma lista mediante confirmação.

## Comportamento da interface

- A API continua ordenando listas por `updatedAt` decrescente, com `id` como desempate. A barra lateral mostra as três primeiras por padrão, independentemente da fonte selecionada no formulário de busca.
- “Ver todas” expande a barra lateral; “Mostrar menos” volta às três primeiras. Uma lista selecionada fora das três primeiras deve continuar visível: ao selecioná-la na visão expandida, a barra permanece expandida até o usuário recolhê-la ou selecionar outra lista recente.
- Na visão expandida, o Talk carrega listas em páginas de até 50, com “Carregar mais” quando a página recebida tem 50 itens. A contagem exibida não deve ser apresentada como total exato enquanto houver páginas ainda não carregadas; nesse caso, exibir “50+”, “100+” etc. Após uma página menor que 50, a contagem passa a ser exata.
- Cada item tem uma ação “Excluir lista”, separada do botão que seleciona a lista. A confirmação mostra o nome e deixa explícito que a lista, seus resultados, verificações de WhatsApp e jobs serão removidos permanentemente. Nenhuma exclusão ocorre sem confirmação.
- Enquanto uma busca ou verificação da lista estiver ativa (`queued` ou `running`), o backend recusa a exclusão com uma mensagem específica. Listas que já tenham contatos importados também não podem ser excluídas: a origem desses contatos deve permanecer rastreável. O Talk mostra a razão recebida, sem retirar a lista da tela.
- Após exclusão bem-sucedida, a lista some da barra lateral. Se era a selecionada, o Talk seleciona a lista restante mais recente, ou mostra o estado vazio quando não restar nenhuma. Resultados, seleção de linhas, jobs e mensagens de erro da lista anterior são limpos.
- Erros de rede ou conflitos não mudam a lista local nem a seleção. Botões de confirmação são desabilitados durante a solicitação para evitar pedidos duplicados.

## Arquitetura e dados

- A interface usa o `DELETE /leads/lists/:listId` já existente, adicionando apenas a função correspondente no cliente Web. A leitura de listas passa a informar `page` e `pageSize=50`, sem mudar o formato da resposta da API.
- A barra lateral mantém apenas o estado de expansão e as ações visuais; `LeadsPage` coordena paginação, exclusão, seleção e recarga. A paginação não deve duplicar itens ao receber uma lista recém-criada ou atualizada.
- O serviço de Leads verifica, dentro do workspace autenticado, se existem jobs ativos ou vínculos de proveniência antes de excluir. A verificação e a exclusão usam transação serializável ou bloqueio equivalente da linha da lista; conflitos de concorrência são tratados explicitamente. Falhas de regra retornam erro de domínio `LEAD_INVALID_TRANSITION` (HTTP 409); listas de outro workspace continuam respondendo como inexistentes.
- Não haverá coluna de arquivo, migração, exclusão em massa ou alteração de contatos já cadastrados. Arquivamento fica fora deste incremento.

## Testes e aceitação

- Testes Web cobrem três listas iniciais, expansão/recolhimento, carregamento da segunda página, confirmação/cancelamento de exclusão, seleção substituta e falha sem alteração de estado.
- Testes de API cobrem exclusão de lista simples, isolamento por workspace, bloqueio por job ativo, bloqueio por proveniência e resposta HTTP 409.
- O resultado é aceito quando uma busca nova aparece entre as três primeiras, listas antigas continuam acessíveis, uma lista de teste sem dependências pode ser excluída com confirmação, e uma lista já utilizada para importar contatos exibe o motivo do bloqueio sem perder seus dados.
