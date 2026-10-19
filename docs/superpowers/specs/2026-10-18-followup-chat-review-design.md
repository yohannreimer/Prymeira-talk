# Revisão de follow-ups na conversa

Desenho aprovado pelo usuário em 18/10/2026 na prévia `followups-revisao-previa-v2.html`, incluindo a fila lateral de “Ver todos”. Autorizada implementação, PR, merge após CI verde e publicação. Não enviar mensagens durante a validação.

Em “Para revisar”, uma conversa ocupa a área principal. As mensagens recentes aparecem em ordem cronológica, com autores, datas e anexos. O rascunho fica em um campo editável abaixo do histórico; Enviar ao lado. Adiar, cancelar e não acompanhar mantêm suas semânticas atuais. Pular apenas muda a seleção. Uma decisão bem-sucedida que remove o item abre a próxima conversa; falhas mantêm o item e mostram o erro.

“Ver todos” abre uma fila com busca, contato, canal, mensagem âncora e data. Em telas largas fica ao lado da conversa; em telas estreitas sobrepõe a área e fecha ao selecionar. O rascunho editado sobrevive à navegação entre itens da mesma versão. Novas mensagens ou atualização do follow-up invalidam a edição e recarregam o contexto.

Usar o GET autenticado de mensagens existente, sem marcar conversa como lida. Mostrar inicialmente até 20 mensagens das 100 retornadas pelo endpoint; revelar mais em lotes de 20 e oferecer abrir o atendimento para contexto além do limite. Não apresentar o limite como histórico completo. Reutilizar mídia autenticada do atendimento. Manter lembretes, agendados, enviados, cancelados e configuração nas telas existentes.

O envio permanece explícito, com `expectedUpdatedAt`, sem atalhos de teclado. Desabilitar envio durante carregamento/falha de contexto ou ação pendente. Manter confirmação distinta de cancelar um follow-up versus não acompanhar a conversa. Eventos em tempo real e respostas assíncronas de conversas anteriores não podem trocar o histórico da seleção atual. Sem migration, variável nova ou mudança no gerador de follow-ups.

Validar edição/versionamento, carregamento/falha/troca de contexto, seleção e avanço, confirmações, fila/busca, mídia e separação de lembretes com testes de componentes. Inspecionar desktop e tela estreita com dados sintéticos. Publicar imagens do manifesto do commit validado e verificar revisão, réplicas, saúde e logs da API.
