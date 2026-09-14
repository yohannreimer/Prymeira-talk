# Editor visual e gravação de voz — 14/09/2026

## Escopo aprovado

Negrito/itálico visíveis durante a edição, preservando o formato WhatsApp na API. Microfone com gravar, parar, ouvir, descartar e enviar explicitamente. Nenhuma mudança no agente ou no envio automático.

## Implementação

- Editor Tiptap restrito a texto, negrito, itálico e quebras de linha; colagem sem HTML arbitrário, toolbar com seleção preservada, emoji inline e sugestões compatíveis.
- Gravador usa o microfone somente após clique e permissão do navegador. Libera o dispositivo ao parar, descartar ou trocar de conversa; cancela permissões tardias. Limites: 5 minutos e 8 MiB. Falha de envio mantém a prévia, sem repetição automática.
- API valida áudio local e converte para OGG/Opus com ffmpeg, tempo/concor­rência limitados e limpeza de temporários. Usa sendWhatsAppAudio da Evolution, com a instância da própria conversa. Não envia como documento.
- Permissions-Policy permite solicitar microfone somente na própria origem. Câmera, localização e CSP permanecem restritas. Não há migração de banco.

## Evidências antes da publicação

- Web: 141 testes aprovados. API: 844 aprovados, 10 ignorados existentes. Shared: 51 aprovados.
- Typecheck da API, build web (inclui TypeScript), build:prod da API e git diff --check aprovados.
- Teste sintético real de WAV → OGG/Opus, com cliente de transporte simulado, validou endpoint, instância, tipo de mensagem e duração persistida.
- Navegador local: negrito e itálico visuais; sugestão formatada; emoji na mesma linha; Shift+Enter e Enter; troca de conversa; captura real do microfone, reprodução da prévia e descarte sem envio.
- Harness isolado em apps/web/composer-check.html, sem chamadas de envio ao WhatsApp; não é entrada do build de produção.

## Limites da validação

Não foi enviado áudio para um cliente real. A entrega ponta a ponta no WhatsApp ainda depende de um destinatário de teste escolhido pelo usuário. Testes simulados de transporte não equivalem a entrega real. Durante o teste local, o controle nativo de áudio provocou falha na aba do navegador integrado; a prévia foi substituída por botão próprio e a reprodução foi validada na nova aba.

## Publicação

Publicados API e web pelo SHA `cc7326f11a498c6c49c4ebf6dadd6da95e3df148`, nessa ordem, com health 200 antes da atualização web. Workflow `34907585675` aprovado nos dois builds. O primeiro build (`34907391290`) falhou por lockfile gerado pelo pnpm 9 local, sem a configuração injectWorkspacePackages exigida pelo pnpm 10 do Docker; regenerado com pnpm 10.0.0 e instalação frozen validada. Nenhum serviço foi alterado antes do build aprovado.

Produção verificada: API health 200; web HTTP 200; bundle `/assets/index-D3uqptTL.js`; Permissions-Policy `camera=(), microphone=(self), geolocation=()`. Editor real com texto sintético confirmou strong/em no DOM, sem asteriscos visíveis. Rascunho removido sem envio. Captura real de aproximadamente 31 segundos no Talk, prévia reproduzida pelo botão próprio e gravação descartada; nenhuma chamada de envio ao WhatsApp foi feita. Servidor local do harness encerrado.

Rollback de ambos os serviços: `66691e4403bf42241a130dda068c433cf80b560f`. A entrega real no aparelho destinatário continua pendente de teste autorizado, conforme limites acima.
