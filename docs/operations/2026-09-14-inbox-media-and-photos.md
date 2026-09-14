# Mídias e fotos no atendimento

Pedido: reproduzir áudio dentro do Talk, abrir imagens e PDFs com apresentação familiar ao WhatsApp, e mostrar fotos dos contatos. Escopo genérico do produto; sem alterar prompt, agentes, histórico, aprovação manual ou transporte de mensagens.

## Diagnóstico

A interface bloqueava OGG/Opus por extensão, deixando só um link externo. O texto “Processando áudio” era inferido de um placeholder, não de um processamento real. O mesmo corpo do documento aparecia no cartão e novamente abaixo. Os avatares da lista eram os primeiros dois caracteres do ID interno, não iniciais.

Consulta somente leitura no workspace vendas5 em 14/09: amostra mais recente de mídias de Vendas 5 tinha 12 áudios OGG, 13 imagens JPEG e cinco PDFs; Geral tinha oito áudios OGG, oito imagens JPEG, quatro PDFs, um vídeo MP4 e um arquivo remoto. Consulta de foto a um contato por canal retornou HTTP 200 com profilePictureUrl. Nenhum corpo ou foto privada foi copiado para fixtures.

## Implementação

- Endpoint autenticado por conversa/mensagem, sempre conferindo workspace antes do cache. Converte OGG/Opus/WebM para MP3 com ffmpeg sem chamada à IA. Tenta recuperar o arquivo pela instância proprietária quando o endereço original falta/expirou. Limite de 25 MiB; cache de 64 MiB/256 entradas por processo, 15 minutos; duas tarefas simultâneas e fila limitada.
- Áudio com play/pausa, posição, tempo e velocidades 1×/1,5×/2×; transcrição em detalhe recolhido. Erro explícito com tentativa, sem falso estado de processamento. Não há waveform fictícia.
- Imagem com prévia proporcional, ampliação em diálogo e download; figurinha compacta. Legendas reais preservadas, placeholders omitidos.
- Documento com nome uma vez, abertura e download separados. PDF renderizado pelo Poppler, uma página por vez, com navegação. O iframe nativo foi rejeitado após teste mostrar tela em branco no navegador embutido. A prévia rasterizada funcionou nas duas páginas sintéticas.
- Busca autenticada de foto na Evolution, cache por conversa/instância e carregamento sob demanda. Foto indisponível mantém iniciais do nome ou ícone, nunca dígitos do ID. Sem escrever contatos ou mudar privacidade do WhatsApp.
- Novas mensagens preservam nome do arquivo, legenda e duração disponível como metadados de apresentação, separados dos dados privados do provedor.

## Verificação local

Regressões escritas antes dos componentes/serviço. Testes cobrem OGG, cache, isolamento entre workspaces, recuperação pelo canal correto, PDF/páginas, legenda/nome separados, foto indisponível e campos públicos permitidos. Browser harness com React real e backend sintético usando ffmpeg/Poppler reais: play, pausa, avanço até 12 segundos, velocidade, erro sem arquivo, PDF de duas páginas, imagem ampliada e Escape. Não envia WhatsApp nem usa IA. Tentativas de ler o elemento audio oculto por evaluate tiveram timeout na ferramenta; a verificação dos controles visíveis funcionou.

Reprodução manual: `pnpm --filter @prymeira-talk/api exec tsx scripts/inbox-media-check.ts` e `pnpm --filter @prymeira-talk/web exec vite --host 127.0.0.1 --port 57217`, abrir `/media-check.html`. Usa somente dados sintéticos e token fixture, bind de loopback. Encerrar o script libera seus arquivos temporários.

Limites: não se garante recuperar mídia que o WhatsApp já removeu. PDFs protegidos/corrompidos podem não gerar prévia; download continua disponível quando há bytes. Perfil oculto pelo titular permanece sem foto. Dois envios com mesmo nome não são apagados ou fundidos: podem ser mensagens distintas. Esta mudança não afirma corrigir a leitura semântica de todos os anexos pela IA.

Publicação ainda pendente neste registro inicial; atualizar abaixo com commit, imagens e evidência de produção.
