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

Pendente de sessão autenticada no Portainer. Publicar API e depois web pelo mesmo SHA imutável; aguardar health 200 entre serviços e validar o editor sem enviar a clientes. Rollback de ambos: 66691e4403bf42241a130dda068c433cf80b560f.
