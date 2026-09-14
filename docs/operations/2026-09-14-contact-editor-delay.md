# Espera de mensagens e nome do contato

Mudança solicitada em 14/09/2026: de dois para cinco segundos sem nova mensagem antes de gerar sugestões. Mantido teto de dez segundos para agrupar mensagens contínuas. Não é prazo de resposta do modelo. Sem alteração de envio manual, controle humano ou prompt.

Novo cartão de contato na conversa com nome, telefone, canal e botão Editar/Adicionar nome. Formulário inline com Salvar/Cancelar, Enter para salvar, Escape para cancelar, foco restaurado, limite de 200 caracteres e erro sem perder o texto. Usa PATCH /contacts/:contactId existente, sem tocar telefone ou outros campos. Atualiza todas as conversas desse contato no estado local e mantém eventos contact.updated. O cartão é recriado ao trocar contato para não transportar uma edição pendente.

Verificação local: teste do debounce falhou com 3000 versus 6000 e passou após a mudança. Teste do cartão falhou sem implementação e passou depois. Suíte isolada: API 830 aprovados/10 ignorados; web 116 aprovados; shared 51 aprovados. Typechecks e builds aprovados (aviso preexistente de bundle web grande).

Teste no navegador com componente real e persistência simulada, sem WhatsApp: edição e gravação, nome vazio rejeitado sem chamada, estado Salvando com controles bloqueados, falha mantendo o texto, troca de contato limpando edição pendente, Escape cancelando e preservação do rascunho da mensagem. Nenhum contato real renomeado como teste. O harness temporário foi removido; estes testes de navegador não provam a rede de produção.

Checkout isolado baseado no commit publicado 3ae8c4a. Não inclui alterações experimentais de runtime/mídia/prompt presentes no checkout Assisted Pilot.
