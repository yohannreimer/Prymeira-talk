# Atendimento comercial de entrada pelo WhatsApp

Desenho aprovado por Yohann em 18/10/2026: criar agente separado para pessoas que chegam diretamente dos anúncios. Reaproveitar as fontes atuais da Maria, explicar a solução, tirar dúvidas e marcar uma call. Consulta ao PostgreSQL pelo Portainer autorizada. Yohann corrigiu a referência da base para PR #52; a versão integrada 5dc7780140eaaecfc20677469b4814300c91fb8e foi incorporada antes da validação final. O núcleo do harness deve servir a vários clientes, sem misturar suas regras ou dados.

## Arquitetura

Usar o core existente (triagem, leitura, decisão em código, escrita, revisão e rastro). Adicionar uma definição comercial reutilizável, com empresa e instruções obrigatórias por configuração, fontes do agente e disponibilidade da agenda por turno. Não reutilizar o fluxo de produtos da Villefer. A definição comercial não tem empresa, preço, catálogo ou responsável padrão.

O runtime seleciona o fluxo pelo behaviorConfig.harness.agente e exige canais explícitos. O comercial usa a reserva existente de Google Calendar, que confirma disponibilidade antes de escrever e adiciona o link real. A ficha não considera reunião marcada por inferência do modelo. Somente o resultado da agenda confirma marcação.

Criar Maria (WhatsApp dos anúncios) no workspace da Prymeira, com fontes comerciais clonadas da Maria do site e prompt adequado a entrada espontânea. Não pressupor formulário, nome, empresa, faturamento ou anúncio específico. Responder a dúvida antes do convite, uma pergunta por vez, sem emoji, repetição ou promessas sem base. Não exigir cadastro antes de agendar. Preservar a Maria do site, suas fontes e automação. Não enviar mensagens nem criar reuniões reais durante os testes.

## Validação

Testes determinísticos do fluxo, seleção de horário, agenda indisponível, recusa, humano, histórico, revisão e isolamento entre empresas. Regressões do runtime e agendamento. Simulação com modelo real usando apenas fontes empresariais aprovadas e conversas sintéticas; os adaptadores de envio, agenda e persistência não executam ações.
