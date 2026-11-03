# Ações das filas da extensão

Usuário pediu Cancelar follow-up em Para revisar e Desmarcar humano necessário na fila humana. Executar nesta tarefa, sem subagentes. Preservar direção visual A e login nativo.

- [x] Acrescentar comandos estritos cancel-followup (ID/revisão) e complete-handoff (ID da conversa), com conta/canal existentes.
- [x] Revalidar item pelo endpoint de destino da fila e usar apenas os endpoints existentes de cancelamento e complete_handoff_action. Não navegar no WhatsApp para executar a ação.
- [x] Adicionar botão de texto discreto, irmão do botão de abrir, em cada item. Bloquear cliques duplicados, confirmar no servidor antes de retirar o item e atualizar contadores. Exibir erro sem remover pendência em caso de falha. Feedback transitório de 5s.
- [x] Conferir isolamento de canal/ID, revisão obsoleta e tipo de ação; testar ambas as filas no Chromium com HTTP sintético, mantendo URL e campo nativo intactos e sem envio ou reativação da IA.
- [ ] Validar build/typecheck/testes, criar PR, instalar 0.3.1 com as mesmas permissões e conferir presença das ações no piloto sem cancelar pendências reais como teste.
