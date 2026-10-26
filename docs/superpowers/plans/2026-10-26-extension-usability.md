# Ajustes funcionais da extensão

**Objetivo:** reduzir espaço ocupado no painel e permitir abrir conversas mesmo com rascunho na conversa atual, sem apagar ou substituir texto.

**Execução:** nesta tarefa, sem subagentes, conforme escolha do usuário.

**Arquitetura:** ajustes somente na extensão; API e Talk continuam com o mesmo contrato. A navegação nativa fica independente da inserção, que continua restrita ao campo vazio da conversa validada. Motivos humanos recebem rótulos locais em português; motivos desconhecidos usam uma orientação neutra quando forem códigos técnicos.

- [x] Reproduzir no teste Chromium o bloqueio com rascunho de origem e adicionar verificações de expiração em 5 segundos, cabeçalho compacto, fila única e motivos legíveis.
- [x] Em panel.tsx, remover linha Conta conectada, colocar Sair no cabeçalho, limpar avisos ao mudar abas e após 5 segundos quando a operação terminar. Manter estados de progresso até sua conclusão.
- [x] Em QueuePanel.tsx, usar apenas review/human e remover seletores Lembretes/Agendados. Traduzir motivos na lista e ao abrir atendimento humano.
- [x] Em content.ts, remover recusa da navegação por rascunho de origem; nunca modificar o campo de origem. Manter insert-draft.ts bloqueando campo de destino ocupado. Testar ida/volta com rascunhos simulados pelo WhatsApp e destino ocupado.
- [ ] Executar testes da extensão, typecheck/build e Chromium; revisar diff, abrir PR e integrar sem bypass após checks.
- [ ] Atualizar a instalação existente para 0.2.4 sem alterar permissões, validar painel vivo sem envio e entregar pacote, guia e relatório factual local.
