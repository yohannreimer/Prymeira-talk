# Prymeira Talk: Mensagens Padrao e Automacoes em Canvas

Data: 2026-05-24

## Objetivo

Levar o atendimento para um nivel mais operacional:

- Operadores precisam inserir mensagens padrao rapidamente dentro do chat, sem sair da conversa.
- Gestores precisam criar fluxos de automacao visualmente, em um estilo parecido com builders de chatbot, usando blocos conectaveis.
- A estrutura de blocos deve nascer ampla o suficiente para crescer, mas a primeira entrega deve ativar somente os blocos essenciais com comportamento claro.

## Escopo do Primeiro Corte

### Mensagens Padrao

Adicionar um botao no composer do atendimento para abrir uma bandeja de mensagens padrao.

Comportamento:

- O botao fica junto das ferramentas do composer, ao lado de emoji/anexo.
- Ao clicar, abre um popover acima do composer com busca e lista de mensagens.
- Ao selecionar uma mensagem, o texto entra no rascunho do composer.
- O operador revisa e envia manualmente.
- Deve existir um caminho simples para criar, editar e apagar mensagens padrao.

Modelo inicial de mensagem padrao:

- `id`
- `workspaceId`
- `title`
- `body`
- `category`
- `createdAt`
- `updatedAt`

Decisao de UX:

- Usar popover no composer no primeiro corte.
- O painel lateral de detalhes do cliente continua mostrando contexto do atendimento.
- Um painel lateral dedicado pode entrar depois se a biblioteca ficar grande.

### Automacoes em Canvas

Substituir a tela atual de automacoes por um editor visual com canvas.

Biblioteca recomendada:

- Usar `@xyflow/react` como motor de nodes/edges.
- O canvas cuida de zoom, pan, handles, conexoes, selecao, minimap e controles.
- A execucao das automacoes continua no backend da Prymeira Talk.

Funcionalidades do primeiro corte:

- Criar fluxo.
- Editar nome/status.
- Adicionar blocos a partir de uma biblioteca.
- Mover blocos no canvas.
- Conectar blocos com edges.
- Editar configuracao do bloco selecionado.
- Salvar nodes/edges dentro do JSON da automacao.
- Testar fluxo manualmente em modo simulado antes de ativar.

## Biblioteca de Blocos

O sistema deve conhecer uma biblioteca ampla de blocos desde o inicio, mas cada bloco precisa declarar seu nivel de suporte.

Estados de suporte:

- `supported`: aparece e pode ser salvo/testado/executado.
- `visual_only`: aparece para planejamento, mas nao executa.
- `coming_soon`: aparece bloqueado ou com etiqueta "em breve".

### Entrada

Blocos de gatilho:

- Primeira mensagem recebida.
- Mensagem recebida apos X dias sem contato.
- Mensagem recebida com palavra-chave.
- Tag adicionada.
- Etapa do board alterada.
- Conversa encerrada.
- Horario/agendamento.
- Webhook externo.

Primeiro corte suportado:

- Primeira mensagem recebida.
- Mensagem recebida apos X dias sem contato.
- Etapa do board alterada.
- Conversa encerrada.

### Comunicacao

Blocos:

- Enviar texto.
- Enviar mensagem padrao.
- Enviar imagem.
- Enviar arquivo/documento.
- Enviar audio gravado.
- Pedir resposta aberta.
- Pedir escolha em opcoes.
- Enviar template aprovado.
- Notificar equipe.

Primeiro corte suportado:

- Enviar texto.
- Enviar mensagem padrao.
- Enviar imagem.
- Enviar arquivo/documento.
- Pedir resposta aberta.

### Decisao

Blocos:

- Condicao por tag.
- Condicao por canal.
- Condicao por horario.
- Condicao por texto recebido.
- Condicao por etapa do CRM.
- Condicao por responsavel.
- Condicao por origem.
- Condicao por status da conversa.

Primeiro corte suportado:

- Condicao por tag.
- Condicao por canal.
- Condicao por horario.
- Condicao por texto recebido.
- Condicao por etapa do CRM.

### Tempo

Blocos:

- Aguardar minutos/horas/dias.
- Aguardar ate horario especifico.
- Aguardar resposta.
- Limitar repeticao.
- Janela de horario comercial.

Primeiro corte suportado:

- Aguardar tempo.
- Aguardar resposta.

### CRM e Atendimento

Blocos:

- Adicionar tag.
- Remover tag.
- Mover contato para board/etapa.
- Atribuir responsavel.
- Alterar prioridade.
- Criar nota interna.
- Fechar conversa.
- Criar/atualizar contato.
- Criar tarefa.

Primeiro corte suportado:

- Adicionar tag.
- Remover tag.
- Mover contato para board/etapa.
- Atribuir responsavel.
- Alterar prioridade.
- Criar nota interna.
- Fechar conversa.

### Integracao

Blocos:

- Webhook/HTTP request.
- IA: classificar mensagem.
- IA: gerar resumo.
- IA: sugerir resposta.
- Enriquecer contato.
- Enviar para sistema externo.

Primeiro corte:

- Todos ficam como `coming_soon` ou `visual_only`.

### Controle

Blocos:

- Finalizar fluxo.
- Pular etapa.
- Evitar duplicidade.
- Marcar erro.
- Registrar evento.

Primeiro corte suportado:

- Finalizar fluxo.
- Registrar evento em modo simulado.

## Modelo de Dados do Fluxo

O campo `actions` da automacao passa a guardar uma definicao visual versionada.

Formato proposto:

```json
{
  "version": 1,
  "nodes": [
    {
      "id": "node_123",
      "type": "send_message",
      "position": { "x": 320, "y": 120 },
      "data": {
        "title": "Enviar mensagem",
        "config": {
          "text": "Ola, {{contact.name}}!"
        }
      }
    }
  ],
  "edges": [
    {
      "id": "edge_123",
      "source": "node_123",
      "target": "node_456",
      "sourceHandle": "success",
      "targetHandle": "input"
    }
  ]
}
```

O campo `trigger` continua existindo para compatibilidade e listagem rapida, mas o bloco de gatilho no canvas passa a ser a fonte principal da configuracao.

## Validacao

O frontend deve validar:

- Fluxo precisa ter pelo menos um bloco de gatilho.
- Blocos obrigatorios precisam ter configuracao completa.
- Edges nao podem criar ciclos no primeiro corte.
- Blocos `coming_soon` nao podem ser salvos como ativos.
- Blocos sem suporte real devem mostrar etiqueta clara.

O backend deve validar:

- `actions.version` suportada.
- Nodes e edges com ids unicos.
- Tipos de blocos conhecidos.
- Configuracoes minimas por tipo suportado.
- Fluxos ativos nao podem conter blocos bloqueados.

## Execucao

Primeiro corte:

- Teste manual continua criando `AutomationRun`.
- O resultado do teste lista os blocos em ordem de execucao simulada.
- Nenhuma automacao nova dispara automaticamente em webhook real ate o runner ser implementado no corte seguinte.

Corte seguinte:

- Criar runner real para eventos de conversa.
- Comecar por gatilhos de primeira mensagem e mensagem apos X dias.
- Executar acoes de mensagem, arquivo, tag e CRM.
- Registrar status por bloco dentro do run.

## UX do Canvas

Layout:

- Barra superior com nome do fluxo, salvar, desfazer, refazer, ativar/pausar e testar.
- Botao `+ Bloco` abre uma biblioteca categorizada.
- Canvas central com fundo pontilhado discreto.
- Controles de zoom/pan e minimap.
- Painel lateral de configuracao do bloco selecionado.
- Lista de runs/testes em uma aba ou painel secundario.

Estados:

- Alteracoes nao salvas.
- Bloco invalido.
- Bloco em breve.
- Fluxo ativo/pausado.
- Teste em execucao.
- Teste concluido com resumo por bloco.

## Testes

API:

- Criar/listar/atualizar automacao com `actions.version = 1`.
- Rejeitar fluxo ativo com bloco `coming_soon`.
- Teste manual retorna actionResults por bloco.
- Validar trigger e nodes obrigatorios.

Web:

- Renderizar canvas com blocos iniciais.
- Adicionar bloco.
- Conectar blocos.
- Editar configuracao de bloco.
- Salvar fluxo.
- Mostrar erro visual em bloco invalido.
- Inserir mensagem padrao no composer.
- Criar/editar/apagar mensagem padrao.

## Fora do Primeiro Corte

- Execucao automatica real no webhook.
- Branches complexas com multiplas condicoes aninhadas.
- Analytics por bloco.
- Versionamento avancado de fluxo.
- Marketplace de templates de automacao.
- Integracoes externas reais.
