# Histórico de 30 dias no apoio privado

## Escopo aprovado

Importação anterior às conversas recebidas no canal Diogo, mantendo aprovação humana. O intervalo é fixado em 30 dias antes da primeira mensagem conhecida no Talk, não 30 dias antes de cada nova resposta. Mensagens posteriores continuam entrando pelo webhook. Identidade vem de um ID de mensagem conhecido e JIDs/alternativas comprovados na Evolution, não do nome exibido.

## Implementação

Commit de código `837168dfb3088dc95350a72e8bd535ce6e2e3c36`; plano e desenho no commit `e3b7145`. Fonte paginada somente de leitura, duas passagens convergentes, limite de 50 páginas, validação de origem e intervalo. Importador transacional com metadados de origem/conclusão, datas originais, conflitos entre conversas rejeitados e deduplicação. Não executa webhook, envio, automação, contador de novas, atribuição ou controle humano.

Opt-in: `channel.encryptedConfig.assistantHistory.days = 30`. O scheduler chama a preparação antes de carregar contexto e gerar sugestão; erro aparece no apoio. Outros canais ficam sem alteração. Anexos históricos de ambos os lados podem usar os leitores existentes e cache vinculado ao arquivo. Não presume condições atuais a partir de propostas antigas.

Limites: 2.000 mensagens no contexto; 120.000 caracteres no gerador; 8 MiB por mídia e cinco páginas por PDF. Por importação há orçamento de 32 MiB em URLs base64 e quatro minutos para iniciar novas recuperações de mídia; o que não couber continua explicitamente não lido. Não há suporte universal de formatos. Imports concluídos não refazem automaticamente mídias falhas; vendedor pode solicitar revisão.

## Verificação local

Suíte com outras alterações locais: 814 testes aprovados, dez dependentes de banco ignorados. Verificação do **commit isolado para publicação**: 813 aprovados, dez ignorados; typecheck e build de produção passaram. Dependências reutilizadas do checkout existente após falha do cache na instalação; fontes verificadas foram as do commit isolado. SHA-256 do bundle: `142a27787b5ebf96f614c4b7fde602c51e4bc707b823fe78e3f9b1f4f4a3247f`.

Regressões novas: ausência do leitor/importador; duas falhas do scheduler (não preparar contexto e gerar mesmo após falha); proposta histórica do vendedor não entrava no contexto. Todos passaram após implementação. Testes também cobrem intervalo, identidade, paginação, duplicatas, falta da âncora, conflito, idempotência, metadados, controle humano, dry-run e mídia indisponível.

Não foram incluídas as candidatas de prompt nem AJ-012/AJ-013 ainda locais. A correção de nomes dos campos de webhook (AJ-019) foi incluída para evitar nova perda de base64 ao reconectar.

## Implantação e evidência

Workflow `34857035679` concluído com sucesso; imagem imutável `ghcr.io/yohannreimer/prymeira-talk-api:837168dfb3088dc95350a72e8bd535ce6e2e3c36`. Atualização aplicada pelo campo de imagem do serviço da API no Portainer, sem usar editor antigo da stack. Verificação do novo processo, importação real e ativação do opt-in ainda pendentes neste checkpoint.

**Verificação publicada:** container `caa031f92ba197cf649d16f47ec18d18b41f78635f494b6daca79e9e1d80e3b0`, task `u5ua2y09apagdm1lzhnyujaqs`, em execução. `/api/health` e `/api/ready` retornaram 200 após o reinício. Houve 502 transitório durante a troca stop-first existente. O SHA bruto local diferiu porque as dependências compartilhadas estavam vinculadas ao checkout anterior: seis comentários de caminho do bundle. Normalizando exclusivamente esse prefixo de comentário, o hash local corresponde exatamente ao remoto: `80a4fae7aa5027feedd7a30d50290cc1ddbe41a5cef5f4c3fa30a9c6ed1aebbb`. Nenhum código executável foi excluído da comparação. A primeira execução diagnóstica parou na checagem de hash, antes de consultas de histórico ou gravações de negócio.

**Dry-run no bundle publicado:** seis conversas e **442 mensagens ausentes**, incluindo 31 anexos. Identidades validadas por IDs de mensagens; duas passagens convergentes por conversa. Prompt salvo teve hash original conferido e modo assistido permaneceu `automatic` (somente rascunhos). Arquivos privados atuais em `/app/.history-pilot-20260914/`. O primeiro total comunicado (464) foi uma leitura incorreta da saída visual; a soma computada do arquivo é 442. A asserção interrompeu a primeira tentativa antes de gravar mensagens; número corrigido ao usuário. Importação transacional retomada após essa conferência; totais finais ainda não declarados neste checkpoint.

Diagnóstico anterior preservado em PostgreSQL large object **OID 26845**, gzip JSON de **66.450 bytes**, dois arquivos (`history-preflight.json`, `history-page-preview.json`), hash e leitura de retorno conferidos. Mesma VPS, não backup externo. Contatos e conteúdo permanecem privados, fora do Git.

## Resultado real do primeiro lote

Às 11h50min17s, seis conversas concluídas: **442 mensagens inseridas**, nenhum erro de importação, **24 dos 31 anexos processados e sete não lidos**. A comparação imediata antes/depois confirmou estado, contador de novas, última mensagem/prévia, responsável e controle humano preservados nas seis conversas. Auditoria não encontrou novos envios aprovados nem novas execuções do agente autônomo; os 87 registros globais de execução já existiam antes do lote e não são atividade gerada pela importação.

Às 11h51min15s o opt-in de 30 dias foi aplicado somente no canal Diogo, preservando exatamente o restante da configuração. A resposta visual de conexão do console apresentou erro, mas a leitura posterior do recibo confirmou a gravação; a alteração não foi repetida. O modo assistido e o prompt continuam iguais. A tela de Lucinei exibiu histórico de cotação, proposta em PDF e follow-ups anteriores, além das mensagens recentes.

Uma sétima conversa chegou durante o trabalho. O reteste pelo botão **Ajustar sugestão**, sem orientação adicional e sem enviar, confirmou que a preparação publicada importou mais **17 mensagens** antes de gerar o rascunho. O histórico foi conferido também na interface. A sugestão respeitou a ausência de demanda atual, sem reabrir uma cotação antiga. Essa ação é manual sobre uma sugestão privada; não confundir com envio ao WhatsApp.

Limite de visualização existente: a lista do chat retorna as 100 mensagens mais recentes; o contexto da IA optante lê até 2.000, sem depender desse limite da tela. Paginação visual completa e divisórias por dia não foram implementadas neste escopo. Os anexos não lidos continuam sinalizados no contexto e no apoio; não chamar o lote de leitura perfeita.

## Fechamento da rodada — 14/09/2026, 11h53min51s

Auditoria final: **459 mensagens importadas em sete conversas**, sete marcadores de conclusão, **24 anexos processados e nove não lidos/indisponíveis**. Datas originais e intervalo de procedência conferidos para todas as mensagens importadas. Reexecução dos sete imports concluídos fez **zero chamadas à fonte**. Deltas de envios aprovados e execuções autônomas: **zero**. Prompt, aprovação humana e outros canais preservados. Estes totais não são a bateria semanal nem o estudo comercial dos três meses.

Evidências privadas preservadas no PostgreSQL large object **OID 26878**, gzip JSON de **14.650 bytes**, 12 arquivos, SHA-256 e leitura de retorno conferidos. Recibo em `/app/.history-pilot-20260914/archive-receipt.json`, auditoria em `audit.json`; inclui IDs importados e registros anteriores das seis conversas do primeiro lote. Mesma VPS, não backup externo. Os arquivos e dados identificáveis não foram incluídos no Git.

Limitação visual observada: dois áudios antigos indisponíveis ainda aparecem como “Processando áudio...” na bolha, embora o apoio e o contexto os marquem como não lidos. Correção desse rótulo fica registrada para próxima rodada; não há leitura em andamento comprovada. Sugestões anteriores ao import podem precisar de **Ajustar sugestão**; novas sugestões já usam o contexto persistido. Fechar e reabrir a conversa atualiza o histórico exibido.
