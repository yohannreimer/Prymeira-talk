# Histórico anterior no apoio privado

## Aprovação e objetivo

Em 14/09 o usuário aprovou recuperar os últimos 30 dias das conversas que chegam ao canal Diogo, com mensagens de ambos os lados e anexos recuperáveis, mantendo aprovação humana e sem executar eventos antigos. A execução será sequencial, conforme preferência explícita do usuário; não reabrir discussão técnica já aprovada.

## Desenho

Um importador separado, sem transporte de envio, identifica a conversa por uma mensagem já recebida no Talk e pelo identificador retornado pela Evolution — nunca por semelhança de nome ou telefone. Recupera páginas, limita ao intervalo fixo de 30 dias anterior à primeira mensagem conhecida e exige duas leituras convergentes. Identificadores alternativos só entram quando comprovados no registro original. Falha ou limite não podem virar sucesso silencioso.

O importador insere apenas mensagens ausentes, com datas e direção originais. `ingestedAt` histórico acompanha a data original, para não deslocar a última entrada no agendador. A importação não chama webhook, automações, envio, notificações, marcação de leitura ou roteamento; não muda responsável, controle humano, estado, contadores nem prévia da conversa. Conflito de ID com outra conversa aborta. Persistência transacional e marcador de conclusão evitam repetição; metadados existentes são preservados.

O apoio recupera o histórico antes de gerar uma sugestão em canais explicitamente optantes. Mensagens novas durante a importação continuam protegidas pela revisão/contextKey já existentes. Uma falha de importação deve aparecer como indisponibilidade de contexto, não liberar silenciosamente uma resposta sem ele. Conversas em controle humano não geram sugestões.

Anexos recuperáveis usam a API de mídia da mesma Evolution e os leitores atuais. Falhas/formatos não suportados ficam explicitamente identificados, sem presumir conteúdo. Nenhum suporte novo de vídeo/Office é declarado neste trabalho. Preservar os limites existentes de 8 MiB, cinco páginas de PDF e 2.000 mensagens/120 mil caracteres de contexto. Históricos maiores não devem ser truncados sob o nome de leitura completa.

## Validação e operação

Testar identidade, intervalo, paginação instável, deduplicação, repetição idempotente, conflito entre contas/conversas, preservação de datas/metadados/contadores, mídias indisponíveis e não disparo. Conferir amostra real no Talk e comparar número inserido com a fonte, além de zero envios pela IA. Começar pelas conversas já presentes; habilitar recuperação automática somente depois de publicar o código verificado. Preservar prompt candidato não aprovado fora da implantação. Registrar separadamente código local, importação real e publicação.
