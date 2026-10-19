# Atendimento: evidência e cobertura da resposta

Desenho aprovado por Yohann em 17/10/2026. Execução nesta sessão, sem subagentes.

## Problema observado
O atendimento recebeu uma pergunta sobre chapa de alumínio xadrez. A busca entregou o trecho específico de chapa de piso e a política genérica de alumínio. O leitor citou somente a política; o escritor omitiu até essa informação. A revisão aprovou com segue=0,23 e responde=0,29. A ficha era então marcada como tratada.

## Decisão
Corrigir a cadeia de atendimento com evidência por pergunta. Manter a base completa disponível, apontar trechos específicos não utilizados e permitir citações complementares. Uma conferência final deve impedir que uma leitura ainda incompleta produza uma resposta automática. O escritor deve responder antes da oferta de catálogo. Uma regra de código bloqueia respostas compostas somente por saudação/oferta; o juiz do atendimento confere a cobertura de cada pergunta e aplica limites próprios, sem mudar os demais agentes. Falhas recebem uma reescrita; persistência ou indisponibilidade da revisão encaminha para humano. Perguntas abertas não podem ser marcadas como tratadas por uma mensagem genérica ou aviso de falha.

Alternativas consideradas: somente ajustar instruções (não fornece barreira de envio); somente endurecer o juiz (não melhora a seleção); corrigir a cadeia completa (escolhida).

## Limites
Sem migration, variável nova, envio de teste ou ativação em produção. Sem mudança da política do comprador, prospecção ou juiz de follow-ups. Não copiar toda a base para a mensagem: responder ao que foi perguntado, com as condições necessárias e sem garantir estoque, preço ou combinações não confirmadas. Heurísticas apenas solicitam nova leitura; não afirmam disponibilidade nem fundem fontes automaticamente.

## Verificação
Reproduzir a resposta real em teste antes da correção. Cobrir leitura específica/complementar, reescrita, duas falhas, indisponibilidade do juiz, múltiplas perguntas, cumprimento social, recusa, paráfrase e manutenção das perguntas abertas. Executar testes do harness e typecheck/build da API. Se houver avaliação com JEV, usar somente simulação sem envio e registrar limitações de calibração. O trace deve identificar a pergunta e a causa da rejeição.
