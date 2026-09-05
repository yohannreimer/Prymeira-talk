# Revisão do Agente Comercial Villefer V1

Gerado em 2026-09-05T12:00:00.000Z. Este documento contém somente agregados e paráfrases anonimizadas.

## Base analisada

- 4 instâncias.
- 46.313 mensagens no recorte.
- 5.581 jornadas classificadas como comerciais.
- 1.246 identificadores de contato únicos entre os quatro baselines.
- 1.309 ocorrências de contato ao somar cada instância; a diferença representa contatos presentes em mais de um número.

## Sinais de demanda

| Tema | Jornadas com sinal |
| --- | ---: |
| preco | 629 |
| especificacao | 568 |
| medida_corte | 256 |
| entrega_frete | 195 |
| pagamento | 165 |
| nota_fiscal | 108 |
| estoque | 57 |

## Decisões já aprovadas

- O agente qualifica o pedido e entrega o briefing para o vendedor elaborar a proposta.
- Cada vendedor receberá o pacote em seu próprio Talk, usando variáveis locais.
- O agente não calcula preço nem promete estoque, prazo, frete ou condição comercial sem fonte aprovada.
- A operação usa segunda a sexta, das 8h às 18h, no horário de São Paulo.
- Após proposta confirmada podem existir três follow-ups contextuais; qualquer resposta ou takeover interrompe a cadência.
- A publicação começa em laboratório e avança somente depois de revisão e avaliação.

## Padrões comportamentais usados na V1

- Os pedidos frequentemente chegam como listas incompletas e distribuídas entre texto, áudio, imagem e documento.
- Preço e especificação são os temas mais recorrentes; medida/corte, entrega/frete, pagamento, nota fiscal e estoque também aparecem com frequência.
- A qualificação deve confirmar material, especificação, dimensões, quantidade, destino, modalidade e prazo antes do handoff.
- Objeções observáveis incluem preço, prazo, frete, disponibilidade, conjunto incompleto de itens e aprovação interna.
- Follow-up útil investiga bloqueio ou acrescenta contexto; cobranças genéricas e pressão para fechar devem ser evitadas.
- Erros e correções de quantidade, medida ou item precisam ser tratados como conflito e encaminhados ao vendedor.

## Informações que o responsável da empresa precisa validar

- [ ] Reconciliar antes de nova apresentação a diferença entre 1.246 contatos únicos nos quatro baselines usados pelo compilador e 1.248 contatos no funil executivo anterior, que aplicou outra regra de classificação.
- [ ] Confirmar o catálogo atual, famílias de produto, qualidades, normas, acabamentos e nomenclaturas aceitas.
- [ ] Confirmar medidas padrão, tolerâncias, pesos teóricos, lotes mínimos e regras técnicas que podem ser respondidas sem vendedor.
- [ ] Confirmar quais cortes, dobras e outros beneficiamentos são oferecidos e suas limitações.
- [ ] Confirmar regiões atendidas, unidades, modalidades de retirada, transportadoras e regras atuais de frete.
- [ ] Definir a fonte oficial e atualizada para preço, estoque, prazo e disponibilidade.
- [ ] Confirmar políticas de cadastro, documentos, crédito, pagamento, faturamento e benefícios fiscais.
- [ ] Confirmar para cada Talk o vendedor, departamento, tags e destino exato do handoff.
- [ ] Aprovar a saudação transparente do agente e os textos finais dos três follow-ups.
- [ ] Definir como anexos técnicos ilegíveis, complexos ou conflitantes devem ser escalados.
- [ ] Aprovar critérios operacionais para ganho, perda, adiamento, sem resposta e nutrição futura.
- [ ] Validar política de retenção, anonimização e acesso aos históricos conforme LGPD.

## Regra de publicação

O pacote permanece em laboratório até que as informações factuais sejam aprovadas e os casos eliminatórios da suíte de avaliação sejam aprovados sem falhas.
