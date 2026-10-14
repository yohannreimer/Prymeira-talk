# Follow-ups semanais na Supervisão

Escopo aprovado: aba simples de seleção semanal manual, com as 57 conversas revisadas de 05 a 11/10/2026 (38 follow-ups e 19 lembretes). Não conecta esta lista ao agendador e não dispara mensagens. Outras semanas podem ser acrescentadas manualmente.

A Supervisão mantém sua tela atual e ganha a aba Follow-ups da semana. A lista identifica cliente, vendedor e número do canal. Clicar abre o histórico atual e o formulário de resposta já existentes. Mostra abaixo do histórico a sugestão revisada. Somente sugestões ao cliente podem ser levadas ao formulário por um clique explícito; lembretes internos nunca são preenchidos como resposta ao cliente.

Catálogo semanal privado da API, com identificadores de workspace/conversa, tipo e sugestão. Catálogo inicial incluído no servidor; arquivo JSON opcional configurado por TALK_SUPERVISION_FOLLOWUP_WEEKS_FILE permite publicar novas semanas sem alterar o banco ou o agendador. Requisições validam os vínculos atuais no Hub e consultam as conversas no escopo workspace/canal autorizado. Contagens, catálogo e sugestões são filtrados por esse acesso. Nenhum dado de cliente entra no bundle público da web.

A semana representa a revisão histórica publicada, não prova que a pendência continua aberta. A lista permanece acessível para conversas encerradas, desde que visíveis e autorizadas. Histórico e resposta refletem o atendimento atual; listas e história atualizam pela rotina de supervisão. Revogação e troca de semana limpam histórico e sugestões anteriores.

Verificação: testar isolamento de canais/workspaces, catálogo inválido e ausência de alterações no banco; testar seleção semanal, histórico real, uso explícito da sugestão, lembrete interno não preenchido no formulário e limpeza de acesso revogado. Executar testes de Supervisão, typecheck e build.
