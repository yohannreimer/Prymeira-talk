# Composer voice implementation plan

> Execução inline/sequencial escolhida pelo usuário; usar executing-plans e verification-before-completion. Sem delegação.

**Goal:** Formatação visual e áudio gravado com revisão antes de enviar.

**Architecture:** Componentes separados RichDraft/VoiceRecorder, serialização WhatsApp pura e conversão de áudio limitada no servidor. Não alterar prompts, automação ou histórico.

**Tech Stack:** React, Tiptap/ProseMirror, MediaRecorder, Fastify, ffmpeg, Evolution.

- [ ] Testes vermelhos: serialização negrito/itálico, marcas aninhadas, números/HTML; cliente Evolution usa sendWhatsAppAudio; conversão rejeita tipo/tamanho inválido.
- [ ] Criar `whatsapp-text.tsx`, `RichDraft.tsx`; integrar toolbar, seleção, atalhos, emoji, sugestões e mensagens em `InboxPage.tsx`. Rascunho permanece string compatível com API.
- [ ] Criar `VoiceRecorder.tsx` e ciclo de gravação cancelável. Preview não chama API. Capturar conversa no início; desmontar ao trocar. Exibir timer, parar, descartar, ouvir e enviar; limite 300 s/8 MiB; manter erro visível.
- [ ] `outbound-audio.ts`: validar data URL/MIME/bytes, ffmpeg sem protocolos remotos, duração limitada, temp removido. `conversations.service.ts`: classificar áudio, canal proprietário, endpoint próprio, mensagem de tipo audio. `evolution.client.ts`: método opcional sendAudio para preservar mocks existentes. Rota com bodyLimit compatível e validação.
- [ ] Alterar Permissions-Policy para microphone=(self); demais diretivas preservadas.
- [ ] Rodar `pnpm --filter @prymeira-talk/web test`, `pnpm --filter @prymeira-talk/api test`, typecheck/build e harness no navegador. Testar seleção, B/I, teclado, texto colado, quebra de linha, cancelar gravação, permissão negada, troca de conversa e envio sintético.
- [ ] Publicar imagens por SHA; API health antes da web. Verificar editor em produção sem enviar mensagem a cliente. Registrar limitações do teste de entrega e estado final.
