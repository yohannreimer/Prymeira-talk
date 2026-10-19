# Reiniciar conversa com histórico de transporte protegido

## Resultado aprovado

Yohann pediu a correção e a publicação do botão Reiniciar conversa. Depois do reset, o atendimento deve estar vazio, sem memória da IA, notas, tags, respostas/lembretes pendentes ou vínculo com a campanha. O próximo webhook/mensagem inicia um atendimento novo. Contato, canal, configuração dos agentes e UUID da conversa permanecem estáveis.

## Diagnóstico

O reset atual executa `message.deleteMany`. Em produção isso falha com `ingress_progress_message_fkey`. A remoção direta de bindings de envio também é recusada por `Outbound evidence is immutable`. Essas referências e triggers existem para conservar fatos de transporte; não serão desativadas. O histórico pode incluir conversas retiradas pela resolução PN/LID. O reset atual também deixa triagem, cache de preview e lembretes pendentes.

## Escolha

Apagar mensagens e relaxar as proteções perderia integridade. Trocar o UUID/contato, como no procedimento pontual, exige manipular autoridade e não serve como contrato permanente do botão. A correção marca as mensagens anteriores como `hiddenByReset`, mantendo os comprovantes, e registra `historyResetAt` na conversa. O mesmo atendimento segue ativo e a autoridade PN/LID não muda.

## Transação

Entrar no lock canônico do workspace antes dos locks de conversa. Resolver o conjunto da conversa selecionada e seu histórico retirado no mesmo workspace. Parar prospecção e liberar reservas de envio confirmadas; um envio de resultado desconhecido exige conflito explícito 409, nunca apagar sua prova. Marcar todas as mensagens desse conjunto como ocultas e atualizar o marco de reset. Limpar notas dos contatos desse conjunto e estado operacional (sessões, runs, apoio, sugestões, tags, follow-ups, triagem e lembretes). Limpar timestamps/preview/contagem e reabrir apenas a conversa operante com IA permitida. Registrar auditoria com quantidade e escopo, sem conteúdo das mensagens.

## Histórico e concorrência

O predicado compartilhado de mensagens visíveis exclui `hiddenByReset`. Queries SQL do último item do inbox também o fazem. Leituras de contexto, primeiras mensagens, âncoras e jobs devem obedecer ao mesmo limite. Um trigger aditivo preserva a marca em atualizações e oculta inserts atrasados cujo horário é anterior ao marco da conversa; histórico recuperado não pode reaparecer. Jobs de efeitos e geração revalidam a fonte e o marco de reset antes de produzir efeitos. Checks existentes de claims permanecem.

DTOs levam o marco de reset e a marca de mensagem oculta. O cache central da web aplica marcos monotônicos antes de alertas/realtime/replays HTTP, invalida todos os históricos/contextos do atendimento e descarta eventos anteriores. O botão limpa o alvo original mesmo que a seleção mude durante a requisição. A confirmação diz que o atendimento e memória serão limpos, preservando registros técnicos.

## Verificação e publicação

Regressão PostgreSQL com FKs/triggers reais, ingresso/progresso/efeitos e outbound confirmado: reset 200, UUID estável, evidências intactas, histórico visível e contexto vazios, reservas liberadas, outro workspace intacto; mensagem nova funciona, backfill antigo permanece oculto e reset repetido funciona. Testar rollback e bloqueio de envio incerto, workers e cache/realtime. Rodar typecheck/build e suites pertinentes. Publicar imagens de um único commit baseado nas versões em produção; aplicar migração aditiva antes do rollout; preservar digests anteriores e verificar serviços, health/ready e botão em produção sem enviar mensagem de teste ao WhatsApp.
