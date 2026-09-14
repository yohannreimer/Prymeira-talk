# Avisos contextuais de anexos

Comportamento aprovado pelo usuário: falhas antigas ficam sinalizadas no anexo; na sugestão, aparecem somente quando a resposta atual depende do arquivo. Nunca declarar como lido um arquivo indisponível. Aprovação manual e prompt comercial permanecem iguais.

O mesmo modelo que prepara a resposta recebe todos os anexos não lidos com IDs e datas e informa, em campo estruturado privado, quais são necessários agora. Omissão, decisão inválida ou contraditória mantém o aviso. Anexos novos no turno atual não podem ser silenciados por essa decisão. Não usar apenas idade ou palavras-chave para inferir mudança de assunto. Não remover do contexto a informação de que o conteúdo não foi lido.

O DTO expõe somente o estado seguro `attachmentReadStatus: unread`, sem metadados internos. A bolha mostra o aviso local; áudio conhecido como não lido deixa de aparecer como processando. Caches de falha ficam vinculados ao arquivo, sem impedir tentativas posteriores. Nenhuma alteração de recuperação, catálogo, envio ou controle humano faz parte deste ajuste.

Verificar testes negativos/positivos de relevância, fallback conservador, isolamento de metadados, apresentação de áudio/documento e versão publicada. Regenerar somente a sugestão privada do exemplo real; não enviar mensagem.
