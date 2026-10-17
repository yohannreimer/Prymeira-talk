# Revisor do atendimento por requisitos

Pedido de Yohann: corrigir o falso bloqueio observado na simulação real da chapa e repetir o teste com o modelo real, sem WhatsApp. Trabalho nesta sessão, sem subagentes.

Causa observada: a mensagem útil foi bloqueada por `segue=0,45 < 0,60`, antes de chegar à revisão individual. O serviço só retornou nota e motivo genérico. Não há evidência do motivo semântico específico dessa nota.

Mudança autorizada: retirar o veto por aderência global no atendimento e perguntar por obrigações verificáveis: responder cada pergunta, preservar encomenda, fundamentar fatos e pedir dados ainda ausentes. Cada escolha tem um motivo concreto de reprovação em código, incluindo pergunta/fonte quando aplicável. Catálogo/vendedor é opcional. Saída ausente/inválida do revisor continua impedindo envio automático. Outros agentes e follow-ups preservam suas revisões.

O trace registra tanto requisitos atendidos quanto falhas e os apresenta no narrador. A nota genérica de invenção permanece informativa; o veto factual vem da identificação de uma categoria de fato sem fonte. Isso ainda depende da classificação semântica do JEV, não comprova verdade nem precisão universal.

Verificação: seis testes novos falharam antes da mudança. Regressões cobrem a resposta útil anterior, ausência de encomenda, quantidade, preço sem fonte, segunda pergunta, saída inválida e visualização. Após os checks locais, repetir uma execução completa com Luna/JEV reais e fazer controles de revisão da resposta anterior, da oferta vazia e da condição omitida. Registrar todos os resultados, inclusive falhas, sem escolher só uma execução favorável.
