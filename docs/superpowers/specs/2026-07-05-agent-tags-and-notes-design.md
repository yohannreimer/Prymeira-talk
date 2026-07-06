# Sistema de tags e notas para agentes

## Contexto

O Prymeira Talk já possui agentes autônomos capazes de responder conversas, aplicar tags e criar notas internas. O problema atual é que a IA pode gerar tags muito livres, criando variações como "aguardando comercial", "aguardar comercial" ou "comercial aguardando". Isso prejudica filtros, relatórios, automações e leitura do atendimento.

Também existe uma diferença importante entre tag e nota interna:

- Tag deve ser uma classificação curta, padronizada e reutilizável.
- Nota interna deve registrar contexto específico da conversa para o humano.

## Decisões aprovadas

1. As tags serão globais do workspace.
2. Cada agente terá uma seleção própria de tags permitidas.
3. A IA não deve criar tags livremente.
4. A tag deve ser simples de cadastrar.
5. A primeira versão não terá taxonomia avançada de etapa, intenção, prioridade ou temperatura do lead.
6. Notas internas continuam como texto livre, usadas para contexto e resumo operacional.

## Objetivo

Criar um sistema simples e controlado para que agentes autônomos usem tags oficiais do workspace sem gerar bagunça operacional.

O resultado esperado é:

- O usuário cria tags oficiais uma vez.
- O usuário escolhe quais tags cada agente pode usar.
- O agente recebe somente essas tags no harness.
- O backend valida qualquer ação de tag antes de salvar.
- O agente usa notas internas para informações que não devem virar tag.

## Modelo de tag

Cada tag global deve ter apenas:

- Nome
- Cor
- Quando usar

Exemplo:

Nome: `Lead quente`

Cor: verde

Quando usar: quando o cliente demonstrar intenção clara de compra, pedir preço, proposta, demonstração ou perguntar como contratar.

## Seleção por agente

Na configuração de cada agente deve existir uma área chamada `Tags permitidas` ou equivalente.

Ela mostra as tags globais do workspace e permite marcar quais aquele agente pode aplicar.

Exemplo:

Agente `Prymeira Vendedora` pode usar:

- Lead quente
- Interesse em plano empresa
- Aguardando comercial
- Qualificado

Um futuro agente de suporte poderia usar outro conjunto:

- Dúvida técnica
- Problema de acesso
- Precisa suporte humano

## Como mandar as tags para a IA

O harness do agente deve enviar as tags permitidas de forma direta, junto com a descrição de uso.

Formato conceitual:

```txt
Você pode aplicar somente as tags abaixo quando fizer sentido.
Não invente tags novas.

Tags permitidas:
- Lead quente: quando o cliente demonstrar intenção clara de compra, pedir preço, proposta, demonstração ou perguntar como contratar.
- Aguardando comercial: quando o cliente precisar de atendimento humano comercial, negociação, proposta, desconto ou fechamento.
- Interesse em plano empresa: quando o cliente falar sobre empresa, equipe, múltiplos usuários ou operação com escala.
```

O agente pode escolher uma ou mais tags permitidas, ou nenhuma tag.

## Validação no backend

Mesmo que o prompt oriente a IA, o backend deve ser a fonte de verdade.

Ao receber uma ação de `add_tag`, o backend deve:

1. Normalizar o nome recebido para comparar com segurança.
2. Verificar se a tag existe no catálogo global.
3. Verificar se a tag está permitida para aquele agente.
4. Aplicar a tag somente se passar nessas validações.
5. Registrar no log quando uma tag for ignorada por não ser permitida.

A IA não deve criar tags novas automaticamente.

## Sugestões de novas tags

Quando a IA identificar uma categoria útil que não existe no catálogo, ela pode sugerir uma nova tag.

Essa sugestão deve ficar pendente para aprovação humana, sem afetar a conversa automaticamente.

Primeira versão recomendada:

- Registrar a sugestão no log do agente ou em uma lista simples de sugestões.
- Não criar a tag automaticamente.
- Não aplicar a tag sugerida na conversa.

## Notas internas

Notas internas devem ser usadas para informações específicas da conversa que ajudam o humano, mas não servem como classificação global.

Exemplos de nota interna:

- Cliente quer entender planos para empresa e perguntou onde comprar.
- Cliente parece interessado, mas pediu condição comercial antes de fechar.
- Cliente perguntou sobre preços e mencionou equipe com 5 atendentes.
- IA pediu handoff porque o cliente solicitou proposta personalizada.

O agente pode criar notas quando houver contexto útil para continuidade do atendimento.

## Diferença entre tag e nota

Use tag quando a informação for:

- Curta
- Reutilizável
- Boa para filtro
- Boa para relatório
- Boa para automação futura

Use nota interna quando a informação for:

- Específica daquela conversa
- Explicativa
- Longa demais para virar tag
- Um resumo para o humano
- Um detalhe de próximo passo

Exemplo:

Tag: `Aguardando comercial`

Nota: `Cliente pediu para falar com o comercial porque quer avaliar plano empresa com condição especial.`

## Interface recomendada

### Ajustes de tags

Criar uma tela ou seção de configuração global para tags.

Campos:

- Nome
- Cor
- Quando usar
- Status ativo/inativo

Também deve mostrar se a tag está sendo usada por agentes ou conversas.

### Configuração do agente

Na tela do agente, adicionar uma seção de tags permitidas.

Ela deve permitir:

- Ver tags globais existentes.
- Selecionar quais o agente pode aplicar.
- Ver o campo `Quando usar` para cada tag selecionada.

### Atendimento

Na conversa, tags aplicadas pela IA devem aparecer como tags normais.

Quando possível, o log deve indicar que a tag foi aplicada pela IA, para auditoria.

Notas internas criadas pela IA devem aparecer na área de notas internas da conversa.

## Logs e auditoria

Os logs de teste e automação devem mostrar:

- Quais tags foram enviadas ao agente.
- Quais tags o agente tentou aplicar.
- Quais tags foram aplicadas.
- Quais tags foram recusadas e por qual motivo.
- Quais notas internas foram criadas.
- Se houve sugestão de nova tag.

Isso é importante para entender se o agente está obedecendo a taxonomia.

## Fora de escopo nesta fase

Não implementar nesta primeira versão:

- Etapas estruturadas de funil.
- Intenção estruturada.
- Prioridade estruturada.
- Temperatura do lead.
- Regras complexas de quando não usar uma tag.
- Criação automática de tags pela IA.

Esses itens podem ser avaliados depois que o uso real das tags simples estiver validado.

## Critérios de sucesso

1. O usuário consegue criar tags globais simples.
2. O usuário consegue escolher quais tags cada agente pode usar.
3. O agente recebe no harness apenas as tags permitidas.
4. O agente não cria tags aleatórias.
5. Tags fora do catálogo ou fora da permissão do agente são recusadas com log claro.
6. Notas internas aparecem como contexto textual, não como tags improvisadas.
7. A conversa fica mais organizada para atendimento humano, relatórios e automações futuras.
