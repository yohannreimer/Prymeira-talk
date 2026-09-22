# Contexto recente e seleção de regras para o JEV

Data: 2026-09-22

## Objetivo

Dar ao JEV contexto suficiente para decidir antes da geração e auditar depois, sem enviar o prompt integral do agente em toda requisição. Regras comerciais negativas, como itens não fornecidos, devem chegar ao JEV quando relevantes, junto com os conhecimentos aprovados. Nenhuma semelhança textual, isoladamente, autoriza afirmar preço, estoque, disponibilidade, equivalência técnica ou que um produto não é vendido.

## Estado atual

- `buildConversationContext` lê até 80 mensagens visíveis, em ordem cronológica, para a execução normal.
- `selectRelevantKnowledge` pontua documentos aprovados por categoria, palavras-chave, título e sobreposição de termos; seleciona até três fontes, seis trechos e 12.000 caracteres.
- O JEV já recebe as dez mensagens mais recentes, mas corta o corpo de cada uma em 2.000 caracteres. Recebe também os primeiros 4.000 caracteres do `systemPrompt`; uma regra posterior pode ficar invisível.
- A busca de conhecimento considera o histórico, mas dá peso maior à mensagem atual. Uma resposta fragmentada do cliente, como “10mm”, pode perder a descrição do produto dada alguns turnos antes.

## Decisão e alternativas

Estender a seleção lexical local existente em TypeScript, com categorias e sinônimos aprovados. Ela não requer chamada adicional de IA nem novo serviço. Enviar o prompt inteiro em cada chamada é mais simples, mas aumenta o volume e pode distrair o JEV com regras irrelevantes. Embeddings ou banco vetorial podem recuperar paráfrases, mas adicionam custo e falsos positivos; só serão considerados se replays mostrarem perdas relevantes da busca lexical.

## Fluxo proposto

1. Construir uma janela recente coerente com as últimas 20 mensagens visíveis de cliente e atendente, incluindo a mensagem atual e preservando a ordem. A mesma janela alimenta a consulta de recuperação, o estado do pré-voo e o estado da auditoria. Aplicar teto total de 24.000 caracteres; se exceder, conservar integralmente as mensagens mais novas e reduzir as mais antigas, registrando truncamento. Notas internas e reservas de follow-up não entram. O histórico maior continua disponível ao GPT conforme o fluxo atual.
2. Dividir o `systemPrompt` por títulos, parágrafos e listas, preservando texto original e posições. Evitar partir uma regra no meio de uma negação ou condição. Regras gerais de segurança e limites comerciais são incluídas em bloco permanente pequeno; as regras específicas concorrem por relevância. A extração é determinística e pode ser recalculada quando o prompt mudar, sem migração de banco.
3. Montar a consulta a partir da demanda atual e das mensagens anteriores que a completam, com preferência pelas mensagens do cliente mais recentes e pelas perguntas do atendente que elas respondem. Usar normalização, termos, expressões, categoria e metadados/aliases aprovados. Mensagens antigas de outro assunto não devem dominar. A busca de documentos prontos continua restrita a fontes `ready` do mesmo agente e workspace.
4. Pontuar separadamente trechos do prompt e conhecimento aprovado, com cotas independentes para que um não expulse o outro. Enviar ao JEV até quatro regras específicas (6.000 caracteres), um bloco permanente de até 1.500 caracteres e até quatro trechos aprovados (6.000 caracteres). Não cortar uma regra no meio: se não couber, escolher outro trecho ou registrar ausência de evidência. Levar texto, tipo de fonte, identificador/posição e motivo da seleção. A mesma evidência vai ao pré-voo e à auditoria; o GPT continua recebendo o `systemPrompt` completo e os conhecimentos selecionados.
5. Se não houver evidência explícita ou houver conflito, o JEV deve marcar o caminho comercial como ambíguo e orientar esclarecimento ou handoff. Uma classificação `not_sold` precisa de regra negativa que cubra o item/serviço pedido, não apenas de categoria ou similaridade. O JEV não aprova novos conhecimentos: isso continua dependendo de resposta humana e aprovação em Aprimoramentos.

## Casos e limites

- Ricardo: a regra específica sobre oxicorte precisa ser selecionada mesmo se estiver depois do caractere 4.000 do prompt. A decisão deve distinguir serviço não prestado de outra especificação que só parece próxima.
- João: “10mm” deve ser lido junto com “barra de 12 m para viga baldrame”. A associação a vergalhão de construção só pode sustentar recusa se houver regra negativa explícita cujo escopo inclua esse uso; um alias aprovado pode ajudar a encontrar essa regra, mas não substituí-la. Caso contrário, esclarecer ou encaminhar.
- Uma regra aprovada depois da resposta humana deve poder ser recuperada na próxima conversa equivalente, sem transformar uma exceção em regra geral.
- Se o JEV falhar ou a seleção não tiver evidência, manter o comportamento seguro atual: não inventar fato comercial e registrar indisponibilidade/ambiguidade para diagnóstico.

## Verificação

- Testes unitários de segmentação do prompt, ranking, aliases, cotas, regras gerais, negação, conflitos, truncamento e isolamento por agente/workspace.
- Testes de integração do runtime assegurando que pré-voo e auditoria recebam a mesma evidência e que o GPT continue com o prompt integral.
- Replays sem envio ao cliente dos casos João e Ricardo, de uma regra negativa no fim do prompt, de uma paráfrase sem alias aprovado e de uma conversa que muda de assunto. Comparar seleção, decisão e custo aproximado com a versão anterior; ajustar pesos/limites antes de publicar.
- Registrar IDs, pontuação e motivo das regras selecionadas nos diagnósticos da execução, sem expor esses dados ao cliente.

## Fora de escopo

Não publicar em produção nesta etapa, aprovar conhecimentos automaticamente, alterar o catálogo comercial ou substituir as decisões comerciais humanas por similaridade semântica.
