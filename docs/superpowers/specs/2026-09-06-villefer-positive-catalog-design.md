# Villefer — Catálogo positivo no pré-atendimento de teste

## Objetivo

Configurar o agente **Pré-atendimento Villefer — Teste** para eliminar dúvidas de pessoas que procuram produtos fora do portfólio, sem encaminhá-las ao vendedor. O agente ativo **Agente Villefer** não será alterado.

## Fonte inicial do catálogo

A primeira versão reutiliza somente os itens explicitamente presentes na base do agente Villefer existente.

### Produtos e serviços autorizados

- Barras chatas e barras maciças
- Cantoneiras
- Chapas lisas, chapas xadrez e chapas expandidas
- Vigas I e vigas U
- Perfil U enrijecido, perfil U estrutural e perfil W com abas paralelas
- Tubos industriais, mecânicos, NBR 5580 e Schedule
- Tubos redondos, quadrados e retangulares
- Perfis com medidas ou comprimentos especiais
- Produtos de aço inoxidável
- Produtos de alumínio
- Corte em barras, corte e dobra e oxicorte

“Outros produtos não ferrosos” não autoriza uma confirmação automática por ser uma categoria aberta. Deve permanecer sujeito a confirmação até que o cliente forneça a lista oficial.

## Regra de decisão

1. Produto presente na lista ou sinônimo inequívoco: confirmar que a Villefer trabalha com a categoria e seguir a qualificação normal.
2. Produto ausente e claramente fora da lista: informar diretamente que a Villefer não trabalha com ele, sem handoff e sem iniciar orçamento.
3. Nome ambíguo ou possível sinônimo: fazer uma única pergunta de esclarecimento antes de aceitar ou recusar.
4. Pedido misto: separar os itens, recusar apenas os não atendidos e continuar com os itens autorizados.
5. A presença no catálogo não confirma medida, estoque, quantidade, preço, prazo, frete ou viabilidade técnica.

## Resposta para produto recusado

Formato natural e curto:

> Não, a Villefer não trabalha com [produto]. Posso te ajudar com algum produto em aço, inox ou alumínio?

O texto pode variar naturalmente, mas deve manter a negativa inequívoca e apenas uma pergunta.

## Arquitetura da configuração

O catálogo positivo fica em uma fonte de conhecimento dedicada, para que cada empresa possa ter sua própria lista sem alterar a lógica geral do produto. O prompt do sistema contém somente a política de decisão e aponta essa fonte como autoridade.

## Verificação mínima

- Fora do catálogo: plástico e computador
- Dentro do catálogo: chapa lisa, tubo quadrado e alumínio
- Ambíguo: um nome incompleto ou possível apelido comercial
- Pedido misto: chapa lisa e plástico
- Restrição: pergunta sobre estoque de um produto autorizado

## Limites desta versão

- Regiões atendidas não serão recusadas automaticamente até existir uma lista oficial de regiões autorizadas.
- A lista inicial poderá ser substituída pela lista definitiva fornecida pelo cliente.
- A mudança será aplicada somente ao agente **Pré-atendimento Villefer — Teste**.
