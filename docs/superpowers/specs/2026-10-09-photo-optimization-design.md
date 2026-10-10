# Otimização de fotos no navegador

Desenho aprovado na conversa em 09/10: reduzir fotos antes do upload, JPEG a 85%, lado maior até 2560 pixels sem ampliar, opção por arquivo de enviar original, manter original quando não houver economia. Documentos e animações não são alterados. Implementação e testes locais; sem commit, push ou deploy por instrução de Yohann.

Escopo desta etapa: compressão no navegador e preparação visível, preservando o transporte e as regras de identidade/envio existentes. Migração para upload binário, limites maiores e prazo de confirmação da Evolution são etapas diferentes e não estão implementadas neste ajuste.

Segurança da imagem: somente JPEG acima de 512 KiB é otimizado automaticamente. PNG (prints/transparência), WebP (possível animação), GIF, SVG, HEIC, PDFs, vídeos e áudio permanecem intactos. JPEG enviado com opção original permanece byte a byte. JPEG malformado ou maior que 60 megapixels permanece original. A qualidade 85% não é porcentagem de fidelidade; imagens técnicas usam a opção original. A preparação usa Worker/OffscreenCanvas quando disponível, um arquivo por vez, sem novas dependências. Falta de suporte, falha ou prazo de 8 segundos mantém original, sem enviar duas vezes. Não há compressão no VPS.

Fluxo: escolha e legenda -> original opcional -> preparação -> leitura do arquivo escolhido -> envio existente. Falha antes/depois da preparação mantém arquivo original, legenda e preferência na conversa de origem. Troca de conversa impede envio à conversa errada. Mensagens e IDs canônicos não são alterados.

Validação: regras e Worker falsificado (falhas, timeout, serialização, encerramento); integração React de lote e restauração; testes em navegador real com fixtures sintéticas (orientação EXIF, JPEG grande, arquivo menor, animação/documentos intactos, saída decodificável); suite web, typecheck/build, checks API/shared. Nenhum WhatsApp real ou dado de cliente usado como fixture.

Atualização de UI solicitada por Yohann: substituir o checkbox visível “Enviar original” por botão HD no canto superior direito da prévia. Menu com Padrão (comprime) e HD (conserva arquivo original), seleção por foto, destaque do HD ativo e bloqueio durante envio. Escape fecha apenas o menu; clique fora e troca de arquivo também fecham. Nenhuma mudança no engine/transporte.
