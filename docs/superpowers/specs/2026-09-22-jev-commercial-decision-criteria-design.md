# Critérios comerciais do JEV para variantes sob consulta e recusas aprovadas

Data: 2026-09-22

## Objetivo

Corrigir duas decisões observadas no replay com o JEV real, sem mudar a política comercial da Villefer: uma barra chata com largura fora da faixa aprovada foi classificada como item de estoque pronto para resposta, e o pedido de vergalhão para viga baldrame do João foi encaminhado ao humano apesar de existir negativa explícita aprovada. O replay deve verificar essas decisões por completo, não apenas se o JEV decidiu continuar.

## Evidência e decisão

- A barra chata solicitada tinha largura de 3/8″ (9,525 mm); o catálogo aprovado informa larguras de 19,05 a 100 mm. O cliente também pediu ASTM A36, enquanto a designação da barra no formulário ainda precisa de confirmação. A família é de linha de estoque, mas essa variante não está confirmada.
- Com os critérios atuais, o JEV respondeu `stock` e `answer_current_request` para esse caso. Em um teste isolado, critérios que diferenciam família de variante produziram `ambiguous` e `handoff`. Com esse plano correto, a auditoria aceitou a frase que apenas promete consultar o vendedor, sem afirmar disponibilidade.
- No caso do João, o histórico fragmentado identifica barra para viga baldrame; a regra aprovada exclui vergalhão de construção civil. O replay retornou `not_sold`, mas `handoff`; o teste existente só verificava `continue`.

A opção escolhida é especificar melhor as perguntas estruturadas enviadas ao JEV e fortalecer o replay. Uma segunda validação determinística de catálogo após a resposta do modelo poderia oferecer mais rigidez, mas exigiria manter outro interpretador de medidas e produtos; fica fora desta correção localizada. Se o replay mostrar instabilidade persistente, essa alternativa deve ser reavaliada separadamente.

## Comportamento projetado

1. `commercialPath=stock` descreve a família de estoque somente se os atributos informados pelo cliente não contrariarem a faixa, o material ou outra restrição aprovada. Dados técnicos ausentes podem levar a uma pergunta de qualificação; não significam disponibilidade da variante nem saldo.
2. Uma medida explicitamente fora da faixa ou uma designação de material/norma ainda não confirmada torna a variante `ambiguous` e pede `nextAction=handoff` para consultar o vendedor, sem prometer fornecimento ou recusar a família inteira.
3. `commercialPath=not_sold` exige negativa explícita aplicável ao item e ao contexto. Quando ela existe e não há pedido explícito de humano nem conflito pendente, `nextAction=answer_current_request` significa comunicar a recusa objetiva ao cliente; o JEV não deve encaminhar só para repetir uma negativa aprovada. João e oxicorte de Ricardo são os exemplos de regressão.
4. Pedido explícito de vendedor continua em `handoff`. Depois de o agente ter feito uma pergunta de qualificação, a resposta do cliente pertence à etapa `qualification`, não a um novo pedido de cotação.
5. O contrato de saída do JEV, o prompt integral do agente, a janela de até 20 mensagens, a recuperação de conhecimento aprovado e a auditoria/fail-closed permanecem iguais. Nenhum critério autoriza afirmar preço, estoque, disponibilidade, prazo ou equivalência técnica sem fonte.

## Componentes e fluxo

- `jev-reply-preflight.ts`: alterar apenas as instruções e critérios de `conversationStage`, `commercialPath` e `nextAction` que causam os desvios acima. O estado enviado e o parser da resposta continuam inalterados.
- `jev-reply-preflight.test.ts`: verificar que o payload ao JEV contém as distinções de variante fora da faixa, negativa explícita e continuação da qualificação; preservar os testes de auditoria e transporte existentes.
- `test-jev-villefer-package-live.ts`: exigir plano completo nos casos de barra fora da faixa, João, Ricardo e pedido de vendedor. Usar o pacote atualizado do repositório como referência principal; o pacote anexado anteriormente pode ser executado como comparação, registrando que sua primeira cadência ainda é de 12 horas, enquanto a efetiva é de 6 horas.

O script continua sem acesso a banco, geração GPT ou transporte WhatsApp. Falha de rede, JEV indisponível, divergência de decisão ou bloqueio indevido de resposta segura devem ser relatados como falha/alerta, nunca convertidos em aprovação silenciosa.

## Critério de aceite

- Testes focados, suíte da API, checagem de tipos e build de produção passam.
- O replay ao vivo do pacote atual aprova os nove cenários de pré-voo, as duas decisões de follow-up e as seis auditorias, sem falhas de segurança nem alertas conservadores. João deve ser `qualification` + `not_sold` + `answer_current_request`; Ricardo deve ser `qualification` + `not_sold` + `answer_current_request`; a barra fora da faixa deve ser `new_quote` + `ambiguous` + `handoff`.
- Nenhuma mensagem é enviada a clientes. O ajuste de cobertura dos follow-ups do canal Vendas 5 e a implantação no Portainer não fazem parte desta mudança.
