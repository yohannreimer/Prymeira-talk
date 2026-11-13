# Recuperação recente antes da fila antiga

Quando há mais de trinta minutos de atraso, o worker WAHA conserva a fila antiga (`recoveredThroughAt`) e passa a guardar duas filas no JSON `historyRecoveryCursor`, versão 2. Não há migração de banco ou ação de sessão. Conexões com atraso curto continuam usando o cursor v1.

- `recentFromAt` delimita a primeira faixa recente; não certifica os dados anteriores a ela.
- `recentThroughAt` só avança depois de duas leituras completas idênticas e sem retenção canônica.
- `recent` e `backlog` guardam cursores, horário de próxima tentativa e contagem de falhas independentes.
- A mesma lease física protege as duas filas. Uma nova geração reinicia as páginas em andamento, preservando a cobertura recente confirmada somente para a mesma sessão/conta.
- Uma geração nova ou mudança de `disconnectedAt` torna a fila recente imediatamente elegível na próxima varredura. Falha/backoff da fila antiga não bloqueia essa tentativa.
- A fila antiga progride nos intervalos entre verificações recentes, sem saltar mensagens não conciliadas.

Na primeira ativação, a faixa recente começa no início conhecido da queda ou nos quinze minutos anteriores à varredura, o que for mais antigo, dentro de um horizonte inicial máximo de quinze dias e sem voltar antes do checkpoint contíguo existente. Depois disso, continua sempre do último ponto recente certificado. Assim, um worker que ficou parado e uma segunda desconexão retomam a faixa que ainda faltava, sem usar o horário do reinício como cobertura presumida. Quedas maiores são processadas em etapas fixas de até quinze dias, com sobreposição de dez minutos e orçamentos de páginas/tempo.

A recuperação continua pelo armazenamento canônico em `recovered_live`: reconhece mensagens que já chegaram pelos webhooks; só as ausentes são criadas. Mensagens recuperadas não disparam agentes ou automações. O roteador de envio, webhooks e a sessão WAHA não são alterados.

Implante somente o worker pelo SHA/digest aprovado no manifesto de release. Confirme prontidão da API, saúde/geração da sessão, avanço de `recentThroughAt` independente da fila antiga e tráfego real. Não desligue o WhatsApp para provar a reconexão: os testes PostgreSQL simulam quedas, concorrência, reinícios e troca de geração sem afetar clientes. Reverter apenas a imagem conserva o checkpoint antigo e as mensagens já persistidas; a imagem antiga não fornece a prioridade recente e pode recomeçar sua janela de verificação v1, sem saltar cobertura.

O horizonte inicial não recupera conteúdo ausente no próprio provedor. Conteúdo realmente divergente, paginação inconsistente ou falha de provedor mantém a faixa correspondente pendente, com retentativa limitada; não marque como recuperada uma faixa com retenções.

A observação autenticada de status também registra a primeira saída de WORKING para STARTING na WAHA. Repetições de STARTING não deslocam o início da queda, e WORKING continua sem conceder elegibilidade por si só; a prova física existente permanece obrigatória. Esse tratamento ocorre no worker de ingresso, sem exigir reinício do WhatsApp ou alteração do roteador de envio.
