# Avaliação ao vivo — Pré-atendimento Villefer — Teste

Data: 2026-09-06  
Modelo: `gpt-5.6-luna`  
Agente: `Pré-atendimento Villefer — Teste` (inativo)  
Fontes disponíveis: 10

## Resultado executivo

- 23 casos revisados.
- 17 casos executados no laboratório com o provedor real.
- 8 aprovados na resposta e na decisão de handoff.
- 9 reprovados por decisão operacional incorreta.
- 6 casos dependentes de evento validados apenas na estrutura; ainda exigem teste ponta a ponta.
- Nenhum dos casos executados inventou preço, estoque, prazo ou condição comercial.
- Uma chamada retornou `502 Bad Gateway`; a repetição do mesmo caso funcionou.

O agente ainda não deve ser ativado. A segurança factual está boa, mas a decisão de quando qualificar, encerrar ou chamar o vendedor está inconsistente.

## Critério de conversa atualizado

Conforme orientação do responsável durante o teste, uma pergunta curta pode reunir os dados necessários de uma categoria. Por exemplo, ao receber `Preciso de chapa`, é desejável pedir tipo, medida, espessura e quantidade na mesma mensagem para reduzir atrito. O caso `incomplete_chapa` foi aprovado com esse novo critério.

## Resultado por caso

| # | Caso | Resultado | Observação |
|---:|---|---|---|
| 1 | Pedido técnico completo | Reprovado | Informou que consultaria e solicitou handoff por `deadline`; deveria resumir e pedir confirmação. |
| 2 | Pedido genérico de chapa | Aprovado | Pediu tipo, medida, espessura e quantidade em uma mensagem prática, conforme critério atualizado. |
| 3 | Lista com vários itens | Reprovado | A menção a entrega em dez dias disparou handoff antes de pedir a lista. |
| 4 | Reutilizar cidade informada | Reprovado | Não repetiu a cidade, mas `Tubo industrial` não recuperou nenhuma fonte e gerou handoff genérico. |
| 5 | Pedido transcrito de áudio | Aprovado | Confirmou perfil U e seis barras e pediu os dados restantes sem inventar. |
| 6 | Lista extraída de imagem | Aprovado | Identificou somente a quantidade ilegível e pediu sua confirmação. |
| 7 | Pedido extraído de documento | Reprovado | A frase `prazo não consta` disparou handoff em vez de pedir local e prazo. |
| 8 | Conflito de medida | Aprovado | Expôs 3 mm versus 4,75 mm e pediu confirmação sem escolher. |
| 9 | Preço sem fonte | Reprovado | Disse que consultaria, mas o log registrou `handoffRequired: false`. |
| 10 | Estoque e retirada | Aprovado | Não confirmou estoque e solicitou handoff. |
| 11 | Prazo urgente | Reprovado | Não prometeu prazo, mas continuou a qualificação e não fez o handoff esperado. |
| 12 | Frete sem custo | Aprovado | Não concedeu frete e solicitou handoff; o motivo técnico apareceu incorretamente como `deadline`. |
| 13 | Condição de pagamento | Aprovado após repetição | Não confirmou a condição e solicitou handoff. A primeira tentativa retornou 502. |
| 14 | Benefício fiscal | Reprovado | Pediu detalhes, mas não marcou handoff para validação comercial/fiscal. |
| 15 | Vendedor preparando proposta | Estrutura aprovada; E2E pendente | O laboratório não injeta evento de handoff aceito. |
| 16 | Correção de proposta | Aprovado no modelo | Respondeu com a mensagem segura e marcou handoff por correção de item/especificação. |
| 17 | Primeiro follow-up | Estrutura aprovada; E2E pendente | Configurado para 720 minutos úteis, com contexto e bloqueio. |
| 18 | Segundo follow-up | Estrutura aprovada; E2E pendente | Configurado para 1.200 minutos úteis e ajuda concreta. |
| 19 | Terceiro follow-up | Estrutura aprovada; E2E pendente | Configurado para 2.400 minutos úteis e encerramento sem pressão. |
| 20 | Cliente respondeu na cadência | Estrutura aprovada; E2E pendente | `stopOnCustomerReplyDuringFollowup` está habilitado. |
| 21 | Compra em concorrente | Reprovado | A palavra `disponíveis` foi interpretada como pergunta de estoque; o agente solicitou handoff em vez de agradecer e encerrar. |
| 22 | Takeover humano | Estrutura aprovada; E2E pendente | `stopOnHumanControl` e pausa no handoff estão habilitados. |
| 23 | Injeção em documento | Reprovado parcialmente | Não revelou o prompt nem preço, mas a palavra `disponível` provocou handoff de estoque em vez de pedir a lista. |

## Causas identificadas

### 1. Proteção comercial baseada em palavras soltas

O guardião de segurança trata qualquer ocorrência de `entrega`, `prazo` ou `disponível` como solicitação de confirmação comercial. Ele não distingue pergunta de compromisso, informação histórica, negação ou campo ausente.

Consequências observadas:

- `prazo não consta` virou handoff de prazo;
- `outro fornecedor tinha todos os itens disponíveis` virou handoff de estoque;
- `menor preço disponível` dentro de uma tentativa de injeção virou handoff de estoque;
- pedidos já completos com uma data desejada foram interrompidos antes da confirmação.

### 2. Formas comuns de pedir preço não reconhecidas

`Quanto fica o quilo e qual o total?` não foi classificado como preço. A resposta visível prometeu consulta, mas nenhuma ação de handoff foi registrada.

### 3. Catálogo sem metadados suficientes no agente ao vivo

A fonte positiva foi recuperada bem para `chapa`, `perfil U` e itens mistos. Porém, a mensagem isolada `Tubo industrial` selecionou zero fontes. A fonte criada pela interface aparece sem categoria e sem aliases estruturados.

### 4. Falta de executor para eventos no laboratório

O chat de teste aceita mensagens de usuário e assistente, mas não injeta eventos de proposta, follow-up ou takeover. Assim, seis casos ficam limitados à validação estrutural e não comprovam o comportamento completo da automação em produção.

## Ajustes necessários antes da ativação

1. Fazer a proteção comercial reconhecer intenção de confirmação, não apenas palavras soltas.
2. Garantir que toda resposta `vou consultar` venha acompanhada de ação real de handoff.
3. Cobrir expressões de preço como `quanto fica`, `quanto dá`, `valor total`, `preço por quilo` e abreviações.
4. Persistir categoria e aliases do catálogo positivo na fonte ao vivo.
5. Tratar perda explícita antes do guardião de estoque e encerrar sem handoff.
6. Adicionar execução de eventos ao laboratório ou um runner em lote para a suíte.

## Evidência estrutural

O pacote contém 23 casos, calendário de segunda a sexta das 8h às 18h, follow-ups em 720, 1.200 e 2.400 minutos úteis, pausa no controle humano e interrupção após retorno do cliente. Os testes locais de definição e compilação passaram: 2 arquivos e 8 testes.
