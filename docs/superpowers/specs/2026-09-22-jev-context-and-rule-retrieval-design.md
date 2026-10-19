# Contexto recente, prompt integral e conhecimento relevante para o JEV

Data: 2026-09-22

## Objetivo

Dar ao JEV o prompt integral do agente e as 20 mensagens recentes para decidir antes da geração e auditar depois. Os conhecimentos aprovados, incluindo os aprimoramentos, ficam todos disponíveis para seleção; cada chamada recebe os relacionados ao pedido. Nenhuma semelhança textual, isoladamente, autoriza afirmar preço, estoque, disponibilidade, equivalência técnica ou que um produto não é vendido.

## Estado atual

- `buildConversationContext` lê até 80 mensagens visíveis, em ordem cronológica, para a execução normal.
- `selectRelevantKnowledge` pontua documentos aprovados por categoria, palavras-chave, título e sobreposição de termos; seleciona até três fontes, seis trechos e 12.000 caracteres.
- O JEV já recebe as dez mensagens mais recentes, mas corta o corpo de cada uma em 2.000 caracteres. Recebe também os primeiros 4.000 caracteres do `systemPrompt`; uma regra posterior pode ficar invisível. O pacote do agente Villefer examinado tem aproximadamente 8.000 caracteres de prompt.
- A busca de conhecimento considera o histórico, mas dá peso maior à mensagem atual. Uma resposta fragmentada do cliente, como “10mm”, pode perder a descrição do produto dada alguns turnos antes.

## Decisão e alternativas

Enviar o prompt inteiro ao JEV é a escolha inicial: ele tem tamanho moderado no agente examinado e nenhuma regra fica invisível por erro da busca. Essa opção aumenta o volume das chamadas, por isso o custo real precisa ser medido antes de publicar. A alternativa de selecionar só trechos do prompt economizaria entrada, mas poderia omitir uma regra comercial decisiva; não será adotada nesta etapa. A seleção lexical local existente em TypeScript continua sendo usada e melhorada apenas para os documentos e aprimoramentos aprovados, que podem crescer sem limite. Embeddings ou banco vetorial só serão considerados se os replays mostrarem perdas relevantes dessa busca.

## Fluxo proposto

1. Construir uma janela com as últimas 20 mensagens visíveis de cliente e atendente, incluindo a mensagem atual e preservando a ordem. A mesma janela alimenta a consulta de recuperação, o estado do pré-voo e o estado da auditoria. Não cortar silenciosamente o corpo de cada mensagem por um limite arbitrário de 2.000 caracteres. Notas internas e reservas de follow-up não entram. O histórico maior continua disponível ao GPT conforme o fluxo atual. Se o provedor rejeitar uma carga excepcionalmente grande, registrar a falha e seguir o caminho seguro existente, sem afirmar que o JEV avaliou um histórico incompleto.
2. Enviar o `systemPrompt` integral e atualizado do agente ao JEV no pré-voo e, quando houver auditoria, nela também. Não usar prefixo fixo nem seleção de partes do prompt. O GPT continua recebendo esse mesmo prompt integral.
3. Montar a consulta para conhecimentos a partir da demanda atual e das mensagens anteriores que a completam, com preferência pelas mensagens do cliente mais recentes e pelas perguntas do atendente que elas respondem. Usar normalização, termos, expressões, categoria e metadados/aliases aprovados. Mensagens antigas de outro assunto não devem dominar. Considerar todas as fontes `ready` do mesmo agente e workspace, inclusive as que vieram de Aprimoramentos; nenhuma fonte é enviada só por existir.
4. Selecionar os trechos de conhecimento mais relevantes dentro de um limite explícito de tamanho. Levar texto, título e identificador de origem ao JEV. O pré-voo e a auditoria veem a mesma seleção; o GPT também a recebe. Registrar IDs, pontuação, motivo da seleção e tamanho do estado do JEV para diagnosticar omissões e medir custo. Caso o número de fontes ultrapasse o limite atual de leitura do runtime, a busca deve paginar ou consultar o conjunto completo de fontes elegíveis em vez de ignorar silenciosamente as mais antigas.
5. Se não houver evidência explícita ou houver conflito, o JEV deve marcar o caminho comercial como ambíguo e orientar esclarecimento ou handoff. Uma classificação `not_sold` precisa de regra negativa que cubra o item/serviço pedido, não apenas de categoria ou similaridade. O JEV não aprova novos conhecimentos: isso continua dependendo de resposta humana e aprovação em Aprimoramentos.

## Casos e limites

- Ricardo: a regra específica sobre oxicorte precisa estar visível ao JEV mesmo se estiver depois do caractere 4.000 do prompt. A decisão deve distinguir serviço não prestado de outra especificação que só parece próxima.
- João: “10mm” deve ser lido junto com “barra de 12 m para viga baldrame”. A associação a vergalhão de construção só pode sustentar recusa se houver regra negativa explícita cujo escopo inclua esse uso; um alias aprovado pode ajudar a encontrar essa regra, mas não substituí-la. Caso contrário, esclarecer ou encaminhar.
- Uma regra aprovada depois da resposta humana deve poder ser recuperada na próxima conversa equivalente, sem transformar uma exceção em regra geral.
- Se o JEV falhar ou a seleção não tiver evidência, manter o comportamento seguro atual: não inventar fato comercial e registrar indisponibilidade/ambiguidade para diagnóstico.

## Verificação

- Testes unitários da janela de 20 mensagens completas, ranking de conhecimento, aliases, negação, conflitos e isolamento por agente/workspace.
- Testes de integração do runtime assegurando que pré-voo e auditoria recebam a mesma evidência e que o GPT continue com o prompt integral.
- Replays sem envio ao cliente dos casos João e Ricardo, de uma regra negativa no fim do prompt, de uma paráfrase sem alias aprovado e de uma conversa que muda de assunto. Comparar seleção, decisão e tamanho/custo das chamadas com a versão anterior; ajustar busca e limites antes de publicar.
- Registrar IDs, pontuação e motivo das regras selecionadas nos diagnósticos da execução, sem expor esses dados ao cliente.

## Fora de escopo

Não publicar em produção nesta etapa, aprovar conhecimentos automaticamente, alterar o catálogo comercial, enviar todos os aprimoramentos em toda chamada ou substituir as decisões comerciais humanas por similaridade semântica.
