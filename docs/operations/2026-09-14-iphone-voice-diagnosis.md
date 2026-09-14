# Áudio entregue, mas indisponível no iPhone — diagnóstico

## Sintoma

Após publicar o gravador (cc7326f), o usuário enviou dois áudios do Geral Villefer ao próprio contato Yohann. WhatsApp iOS mostrou “Este áudio não está mais disponível” ao reproduzir. O usuário identificou o próprio número de teste, final 6920, após pergunta sobre autorização de reenvio.

## Evidências de produção

Consultas somente leitura no banco do Talk e na Evolution, restritas a áudios de saída do Geral Villefer após 23:15 UTC de 14/09/2026:

- 20:20:06 local: mensagem 94a25461…, cerca de 6 segundos, 22.297 bytes, status delivered.
- 20:20:43 local: mensagem e7575db2…, cerca de 3 segundos, 11.873 bytes, status delivered.
- Evolution findMessages: HTTP 200; ambos audio/ogg; codecs=opus, ptt=true.
- Evolution getBase64FromMediaMessage: HTTP 201; bytes recuperados exatamente iguais aos salvos pelo Talk.
- Download direto dos URLs desses dois arquivos em host *.whatsapp.net: HTTP 200. SHA-256 criptografado e original corretos. Descriptografia AES-CBC com HKDF WhatsApp Audio Keys recuperou exatamente os bytes originais.
- Ambos têm OggS/OpusHead válidos. No áudio curto, ffprobe em produção identificou Opus, mono, 48 kHz e start_time=-0.005000.
- Comparação sem envio com perfil de voz da Evolution resultou em start_time=0.006500. Referência: https://github.com/evolution-foundation/evolution-api/blob/main/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts (processAudio inclui avoid_negative_ts make_zero, application voip e remoção de metadados).

Portanto, expiração ou perda dos bytes no CDN não foi reproduzida. Hipótese ainda não confirmada: incompatibilidade no cliente iOS causada pela linha do tempo do Ogg (ou outro detalhe do perfil do arquivo).

## Experimento A — único envio autorizado

Reutilizado somente o áudio curto original do próprio contato. Remux sem recodificar (`-c:a copy -avoid_negative_ts make_zero -f ogg`) preservou o áudio Opus e corrigiu start_time para 0.006500. Enviado pelo mesmo canal, exclusivamente ao número de teste indicado pelo usuário, com encoding=false. Evolution HTTP 201; providerMessageId `3EB03F290CA706CF9F66C7`. Nenhum envio a clientes, alteração de instâncias ou ativação de automação.

**Resultado confirmado pelo usuário:** “consegue, ta perfeito esse”. O reenvio alterou somente a linha do tempo do Ogg, sem recodificar o áudio. Aplicar a normalização explícita `-avoid_negative_ts make_zero` ao conversor do Talk. Não são necessárias mudanças de bitrate, application ou encoding da Evolution para essa correção.

Um teste adicional de normalização de WebM sintético passou sem alteração do conversor; portanto, essa fixture NÃO reproduz o defeito real e não deve ser apresentada como teste vermelho/verde da correção. Criado também teste de contrato que observa o comando ffmpeg real: falhou antes da correção porque o argumento de normalização estava ausente, e passou após inclusão. O teste manual no iPhone é a evidência de reprodução/correção do sintoma real.

## Publicação concluída

- 846 testes da API aprovados; 10 ignorados existentes. Typecheck, build:prod e diff --check aprovados.
- Workflow 34909673312 aprovou imagens de API e web. Atualizada somente API, sem mudança de interface: `689fa439e72cf0263a764bc6bd466ae0471dda1a`.
- Serviço wseof97wna8dqec8jape6nshz confirmou imagem nova; tarefa umyomigke6g8negssagani75h, contêiner 036605cdc7cb36a011b13df759c3fc33917119181b334ad1fb66532f735253bc. API health HTTP 200 após reinício; tarefa anterior shutdown.
- A correção vale para novas gravações/envios. Mensagens antigas já entregues ao WhatsApp não são reescritas. Nenhum reenvio em massa, alteração de agente ou mudança de aprovação manual.
- Rollback API: cc7326f11a498c6c49c4ebf6dadd6da95e3df148 (restaura a incompatibilidade, usar apenas se necessário por outra regressão).
