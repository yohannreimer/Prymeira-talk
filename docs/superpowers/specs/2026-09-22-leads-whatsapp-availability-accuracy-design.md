# Precisão da verificação de WhatsApp nos Leads

## Problema e objetivo

Na lista “Teste Google Maps v1.18 22-09”, o usuário verificou todos os resultados e todos apareceram como “Indisponível”, embora alguns números tenham sido encontrados manualmente no WhatsApp. O código atual aplica `canonicalizePhone` antes da chamada à Evolution; para celulares brasileiros de 13 dígitos, isso remove o 9º dígito. Os testes existentes confirmam a transformação, mas a resposta real da Evolution em produção não foi acessível devido ao bloqueio de segurança do navegador. A correção deve eliminar essa fonte de falso negativo e distinguir ausência confirmada de consulta inconclusiva.

## Semântica aprovada

- Para cada telefone, preservar a sequência de dígitos exibida no lead como candidata primária. `normalizedPhone` pode servir para agrupar registros, mas não deve substituir silenciosamente o número enviado à Evolution quando o original está disponível.
- Para celular brasileiro de 13 dígitos (`55` + DDD + `9` + oito dígitos), a variante de 12 dígitos sem esse `9` pode ser consultada somente se a candidata primária não retornar `available: true`.
- Para um número brasileiro de 12 dígitos, acrescentar o `9` como alternativa somente se os oito dígitos locais já começarem com `9`; não criar uma variante móvel para linhas fixas. Números de outros países e formatos sem variante segura são consultados uma vez.
- Um `available: true` explícito em qualquer candidata torna o telefone “Disponível”. “Indisponível” exige `available: false` explícito em todas as candidatas aplicáveis. Resposta ausente, inválida ou erro de uma candidata impede concluir “Indisponível”; nesse caso, se nenhuma outra candidata for positiva, o status é “Falha na verificação”, com código de erro rastreável.
- A deduplicação entre leads continua por identidade canônica, mas cada grupo guarda a candidata original preferida. Se houver a forma completa de 13 dígitos, ela tem prioridade sobre a reduzida. O resultado de uma variante vale para todos os leads do mesmo grupo canônico.
- Nenhuma mensagem é enviada para testar disponibilidade. Os estados antigos não são reescritos retroativamente: depois da atualização, o usuário precisa executar “Verificar WhatsApp” novamente na lista.

## Fluxo técnico e compatibilidade

- A criação do job persiste as candidatas primária e alternativa por grupo, mantendo a divisão em lotes de até 25 números por requisição à Evolution. Os jobs novos registram explicitamente as candidatas. Em jobs legados pendentes, o processador deriva a variante brasileira segura a partir do número persistido; uma resposta negativa da forma antiga, sozinha, não comprova indisponibilidade.
- O processador consulta primeiro as candidatas primárias em lote. Só consulta alternativas dos grupos sem resposta positiva, também em lotes de até 25. Mantém os retries já existentes para falhas transitórias e registra, por verificação, se o resultado foi positivo, duplamente negativo ou inconclusivo.
- O parser da Evolution continua aceitando `exists`/`available` e o envelope atual. O pareamento de respostas com candidatas considera que a Evolution pode devolver o telefone em forma canônica; a resposta de uma candidata não pode sobrescrever a de outra nem ser atribuída a outro grupo.
- Não há migração de banco: o formato de `LeadJob.input` já é JSON. Nenhum resultado anterior é apagado automaticamente e a importação de contatos não muda de regra neste incremento.

## Testes e aceitação

- Teste de regressão: lead com `+55 (47) 99139-6920` envia `5547991396920` primeiro. Se essa candidata é positiva, o status é “Disponível” e a alternativa não é consultada.
- Se a primária é negativa e a alternativa positiva, o status é “Disponível”. Se ambas são explicitamente negativas, é “Indisponível”. Se uma resposta falta ou falha e nenhuma é positiva, é “Falha na verificação”.
- Testes incluem deduplicação de variantes entre leads, número fixo sem variante móvel, números internacionais, resposta canônica da Evolution, lotes acima de 25 números e leitura de jobs legados.
- A aceitação em produção exige reexecutar a verificação de uma amostra da lista mencionada e comparar ao menos um número reconhecidamente válido com o status final. Sem essa prova, reportar a correção como implantada, mas não como validada contra o caso real.
