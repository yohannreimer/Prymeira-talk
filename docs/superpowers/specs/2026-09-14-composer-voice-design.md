# Compositor visual e gravação de voz

Funcionamento aprovado pelo usuário em 14/09: negrito/itálico visíveis no campo; microfone → gravar → parar → ouvir, descartar ou enviar. Parar nunca envia. Preservar aparência atual, sugestões com aprovação manual e isolamento de conversas.

Editor com seleção, desfazer e atalhos; serializa apenas texto e marcas WhatsApp, nunca HTML para o provedor. Também renderizar essas marcas nas mensagens, sem interpretar HTML ou medidas como marcação. Emoji, mensagens padrão e edição de sugestão continuam no mesmo rascunho. Alternativa de prévia separada não atende à edição visual pedida; editor estruturado evita um contenteditable artesanal sem histórico confiável.

Gravação local por MediaRecorder, MIME escolhido entre suportados, até 5 minutos/8 MiB. Solicitação de microfone apenas após gesto explícito. Parar libera tracks; preview local; envio por botão separado. Navegar de conversa descarta gravação local e cancela permissão tardia. Falha de envio não autoriza retry automático. Reusar canal/contato autenticado da conversa; converter no servidor para OGG/Opus e usar endpoint de voz da Evolution, não envio de documento. Meta não suportado deve explicar sem enviar por outro canal.

Política microphone=(self), sem habilitar câmera/geolocalização ou acesso de terceiros. Testes com bytes sintéticos, sem enviar a clientes reais; teste real de entrega requer destino de teste explicitamente indicado. Não afirmar entrega sem essa verificação.
