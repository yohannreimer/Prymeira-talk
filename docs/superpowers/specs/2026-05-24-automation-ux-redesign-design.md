# Prymeira Talk: Redesenho da Experiencia de Automacoes

Data: 2026-05-24

## Objetivo

Corrigir a experiencia da tela de automacoes para que ela deixe de misturar lista, formulario, canvas, biblioteca de blocos, configuracao e historico no mesmo espaco.

A tela atual deixa o usuario perdido porque o editor abre por padrao, a lista de regras ocupa uma coluna vazia, o canvas fica dentro de uma pagina rolavel e os controles do React Flow aparecem fora do contexto visual. O novo desenho separa os momentos de uso:

- escolher ou criar um fluxo;
- editar o fluxo em um canvas amplo;
- entrar em modo foco quando precisar de mais area de trabalho.

## Fluxo de Navegacao

### A. Hub de automacoes

A tela de automacoes sempre abre no hub.

O hub mostra:

- cards dos fluxos existentes;
- status claro de cada fluxo: ativo, pausado ou rascunho;
- gatilho principal;
- quantidade de execucoes ou ultima execucao, quando existir;
- acao principal "Criar fluxo";
- estado vazio orientado para criar o primeiro fluxo.

Ao clicar em um card, o usuario entra no editor dedicado daquele fluxo.

### B. Editor dedicado

O editor ocupa a area principal da tela. Ele substitui o layout atual de tres colunas fixas.

Estrutura:

- barra superior com voltar, nome do fluxo editavel, status, salvar, testar e menu de mais acoes;
- biblioteca de blocos compacta e recolhivel na esquerda;
- canvas grande no centro, sem depender do scroll da pagina;
- painel de configuracao somente para o bloco selecionado;
- historico de testes minimizado por padrao, acessado por botao ou drawer lateral.

O botao de status nao deve parecer uma acao solta chamada "Habilitar". Ele deve ser apresentado como estado do fluxo:

- "Fluxo pausado";
- "Fluxo ativo";
- "Rascunho".

Quando a ativacao nao for possivel, o proprio controle informa o motivo, por exemplo: "adicione uma mensagem antes de ativar".

### C. Modo foco

Dentro do editor dedicado, o usuario pode entrar em modo foco.

O modo foco:

- maximiza o canvas;
- recolhe biblioteca, configuracao e historico;
- deixa uma barra curta de ferramentas para adicionar blocos, testar, salvar e sair do foco;
- mantem zoom, minimap e controles sempre dentro da area visivel.

Esse modo nao substitui o editor padrao. Ele e uma opcao para fluxos maiores.

## Comportamento do Canvas

O canvas deve ter altura controlada pelo viewport, nao pelo conteudo interno da pagina.

Regras:

- a pagina de editor nao deve criar um scroll vertical longo por causa da biblioteca de blocos;
- blocos novos devem aparecer perto do ponto selecionado ou no centro visivel do canvas;
- se nao houver bloco selecionado, adicionar bloco deve posicionar no centro atual do viewport do canvas;
- o primeiro bloco precisa nascer em posicao visivel;
- o usuario deve conseguir arrastar blocos sem que o scroll da pagina roube o gesto;
- o minimap e controles ficam fixos dentro do canvas.

## Biblioteca de Blocos

A biblioteca continua ampla, mas a apresentacao precisa ser mais leve.

No editor padrao:

- mostrar categorias recolhiveis;
- exibir uma busca no topo;
- manter cards menores;
- separar claramente blocos executaveis, visuais e em breve.

No modo foco:

- abrir uma paleta compacta por botao;
- buscar blocos por nome;
- adicionar bloco sem ocupar uma coluna fixa.

## Configuracao e Historico

Configuracao:

- quando nenhum bloco estiver selecionado, mostrar uma mensagem simples: "Selecione um bloco";
- quando um bloco estiver selecionado, mostrar somente campos daquele bloco;
- o painel nao deve ficar maior que o viewport nem empurrar o canvas.

Historico:

- nao fica aberto por padrao no editor;
- aparece como drawer ou painel recolhivel;
- o topo mostra apenas um resumo curto, como "0 testes" ou "ultimo teste falhou";
- o teste manual deve continuar acessivel pela barra superior.

## Escopo da Implementacao

Implementar a mudanca em duas camadas:

1. Refatorar `AutomationsPage` para ter estados de tela:
   - `hub`;
   - `editor`;
   - `focus`.
2. Ajustar `AutomationCanvas` e estilos para operar com layout de viewport:
   - canvas sem scroll vertical externo;
   - biblioteca recolhivel;
   - historico fora do layout principal;
   - controles sempre visiveis.

Nao faz parte deste redesenho alterar a execucao real das automacoes. A mudanca e de estrutura, navegacao e usabilidade do builder.

## Criterios de Aceite

- Ao entrar em Automacoes, o usuario ve primeiro cards/lista de fluxos, nao o canvas.
- Clicar em um fluxo abre o editor dedicado.
- O editor mostra canvas grande, biblioteca compacta e configuracao contextual.
- O historico nao ocupa uma coluna fixa permanente.
- O usuario pode voltar do editor para o hub.
- O usuario pode alternar entre editor normal e modo foco.
- Blocos adicionados aparecem em uma posicao visivel e podem ser arrastados.
- Nao ha coluna vazia de "Regras" quebrando o layout.
- O estado "ativo/pausado/rascunho" fica claro e nao parece um botao aleatorio.

## Verificacao

- Testes unitarios da tela de automacoes cobrindo hub, entrada no editor, volta ao hub e modo foco.
- Teste manual no browser em desktop verificando scroll, canvas, selecao de bloco e painel de configuracao.
- Build do web app.
