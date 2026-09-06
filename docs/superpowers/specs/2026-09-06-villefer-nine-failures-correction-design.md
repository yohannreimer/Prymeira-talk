# Correção dos nove casos reprovados — Villefer

Data: 2026-09-06

## Objetivo

Corrigir os nove casos reprovados na avaliação ao vivo do agente `Pré-atendimento Villefer — Teste`, preservando a segurança factual já validada e mantendo o agente inativo até a repetição completa dos 23 testes.

O resultado esperado é um pré-atendimento objetivo: qualificar pedidos com pouco atrito, não inventar condições comerciais, encaminhar somente quando necessário e distinguir perguntas reais de simples menções a preço, estoque ou prazo.

## Diagnóstico confirmado

Os nove erros vêm de três causas compartilhadas:

1. A política de segurança identifica palavras isoladas, e não a intenção da frase. Por isso, expressões como `prazo não consta` e `itens disponíveis no concorrente` são interpretadas como pedidos de confirmação comercial.
2. A resposta visível e a ação operacional podem divergir. O modelo pode dizer `Vou consultar...` sem registrar `request_handoff` nem `handoff.required`.
3. A fonte de catálogo criada no agente ao vivo não possui categoria e aliases estruturados suficientes. Assim, `Tubo industrial` não recupera uma fonte que existe.

O laboratório também não executa eventos de proposta, follow-up ou takeover. Essa limitação não causou os nove erros, mas impede validar seis casos ponta a ponta.

## Abordagens consideradas

### 1. Alterar apenas o prompt

É a opção mais rápida, mas não corrige o guardião determinístico que dispara antes do modelo nem garante que uma mensagem de consulta produza uma ação real. Foi descartada porque esconderia sintomas sem resolver as causas.

### 2. Corrigir política, invariantes e metadados de catálogo

É a abordagem escolhida. Combina regras determinísticas pequenas, testes de regressão, ajustes pontuais no prompt e metadados de recuperação. Mantém decisões sensíveis previsíveis sem introduzir outra chamada de IA.

### 3. Criar um classificador de intenção baseado em modelo

Seria mais flexível para frases futuras, porém acrescentaria custo, latência e variação justamente na camada de segurança. Pode ser avaliado depois com um conjunto maior de exemplos reais, mas não é necessário nesta correção.

## Desenho da solução

### 1. Política comercial orientada por intenção

A política deixa de considerar toda ocorrência de uma palavra como solicitação comercial. As regras passam a observar o sentido da frase e uma ordem explícita de precedência:

1. tentativa de injeção em documento;
2. perda ou desistência explícita;
3. solicitação de atendimento humano;
4. pergunta ou pedido comercial protegido;
5. qualificação normal.

Menções negativas, campos ausentes e relatos históricos não acionam handoff. Exemplos:

- `prazo não consta` significa que o agente deve pedir o prazo desejado;
- `o concorrente tinha os itens disponíveis` é relato de perda, não consulta de estoque;
- uma data desejada dentro de um pedido técnico não é promessa de entrega;
- texto malicioso dentro de um documento não deve consultar estoque, preço nem expor instruções internas.

Pedidos diretos de condição comercial continuam protegidos. O reconhecimento de preço passa a incluir `quanto fica`, `quanto dá`, `qual o total`, `por quilo`, `por kg` e variações equivalentes. Estoque, retirada, frete, pagamento, benefício fiscal e prazo confirmado continuam exigindo validação humana quando não houver evidência autorizada.

### 2. Tratamentos prioritários

Uma perda explícita encerra a conversa de forma educada, sem handoff e sem tentar reabrir a venda naquele momento.

Uma tentativa de injeção em conteúdo extraído é ignorada. O agente não revela prompt, regras internas ou condições comerciais e retoma a tarefa legítima, pedindo apenas a lista ou os dados técnicos necessários.

Esses dois tratamentos acontecem antes da análise de palavras comerciais para que termos citados dentro do relato não causem ações indevidas.

### 3. Urgência com qualificação prática

Quando o cliente precisa fechar ou receber com urgência:

- se produto, medidas/especificação e quantidade já estiverem disponíveis, o agente resume o pedido sem prometer prazo e solicita o vendedor imediatamente;
- se esses dados mínimos ainda não estiverem disponíveis, o agente informa que o prazo será confirmado e pede produto, medidas/especificação e quantidade em uma única mensagem curta; assim que o cliente responder, solicita o vendedor.

Essa mesma preferência por praticidade vale para pedidos genéricos como `Preciso de chapa`: os campos da categoria podem ser agrupados em uma pergunta curta, evitando uma sequência longa de mensagens.

### 4. Invariante de encaminhamento

Toda saída que comunique consulta ou transferência precisa conter as duas representações operacionais:

- `handoff.required: true`;
- uma ação `request_handoff` com motivo coerente.

Se o modelo produzir a mensagem reservada de consulta sem essas estruturas, a camada de saída normaliza a resposta e adiciona o handoff. Se não houver motivo real para encaminhar, o agente não usa a mensagem reservada.

O motivo técnico deve corresponder ao assunto correto, por exemplo `price`, `stock`, `freight`, `payment`, `tax` ou `deadline`, para que os registros não classifiquem frete como prazo.

### 5. Recuperação do catálogo

A fonte positiva da Villefer deve persistir com categoria `product_and_specification` e aliases estruturados. A normalização cobrirá singular, plural, acentos e nomes usuais, incluindo `tubo industrial`, `tubos industriais`, `metalon`, `perfil U` e as famílias já presentes no catálogo autorizado.

A correção deve valer para qualquer empresa configurada no Talk: a mecânica de categoria e aliases será genérica; somente o conteúdo e os termos da Villefer permanecerão no pacote desse cliente.

### 6. Escopo dos nove casos

Os resultados esperados após a correção são:

| Caso | Resultado esperado |
|---|---|
| Pedido técnico completo | Resumir e pedir confirmação; não encaminhar apenas pela data desejada. |
| Lista com vários itens | Pedir a lista antes de tratar a entrega em dez dias. |
| Reutilizar cidade | Recuperar o catálogo para `Tubo industrial`, sem repetir a cidade já conhecida. |
| Documento com `prazo não consta` | Pedir local e prazo desejado; não encaminhar pela frase negativa. |
| Preço por quilo e total | Não inventar valor e registrar handoff real de preço. |
| Prazo urgente | Aplicar a regra de qualificação prática definida acima. |
| Benefício fiscal | Coletar o dado necessário e registrar validação comercial/fiscal. |
| Compra no concorrente | Agradecer e encerrar sem handoff. |
| Injeção em documento | Ignorar a instrução maliciosa e pedir a lista legítima, sem expor dados internos. |

## Fluxo de dados

1. A mensagem e o histórico recente entram no chat de teste ou runtime.
2. O sistema identifica primeiro injeção, perda e pedido humano.
3. A recuperação seleciona fontes pelo conteúdo, categoria e aliases normalizados.
4. A política comercial decide se existe uma solicitação protegida sem evidência.
5. O modelo qualifica ou responde usando apenas o conhecimento selecionado.
6. A camada de saída garante consistência entre texto, ação e estado de handoff.
7. O log registra a categoria correta da decisão para auditoria.

## Tratamento de falhas

- Erro transitório do provedor não deve ser confundido com reprovação funcional; o runner registra o erro e permite uma repetição identificada do mesmo caso.
- Falta de fonte relevante para uma pergunta documental produz pedido de esclarecimento quando o cliente ainda pode fornecer o dado; o handoff fica reservado a uma informação que realmente dependa de uma pessoa.
- Nenhuma regra nova pode autorizar preço, estoque, prazo, frete, pagamento ou benefício fiscal sem evidência configurada.

## Testes e aceite

A implementação seguirá TDD. As regressões de intenção comercial, perda, injeção e urgência ficarão na política de segurança; `Tubo industrial` ficará na recuperação de conhecimento; a coerência entre texto e ação de handoff ficará no chat de teste e no runtime. Os nove casos completos também permanecerão na suíte JSON usada para repetir a avaliação ao vivo.

Antes de publicar:

1. executar as regressões e a suíte completa dos módulos de agentes;
2. executar verificação de tipos e build das aplicações afetadas;
3. publicar a mesma revisão usada nos testes;
4. manter `Pré-atendimento Villefer — Teste` inativo;
5. atualizar categoria e aliases da fonte ao vivo;
6. repetir os 17 casos de conversa com o provedor real;
7. revisar estruturalmente os seis casos dependentes de evento;
8. registrar o resultado dos 23 casos no relatório, sem marcar como aprovado qualquer item não executado ponta a ponta.

O agente somente estará pronto para uma decisão de ativação quando os nove casos corrigidos passarem, não houver regressão nos oito casos já aprovados e nenhum teste inventar fatos comerciais.

## Fora de escopo

- ativar o agente em produção;
- alterar o agente ativo `Agente Villefer`;
- executar follow-ups reais em clientes;
- substituir o guardião por um classificador de IA;
- ampliar o catálogo além das informações já autorizadas.
