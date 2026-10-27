# Redesign Talk + Prym

Yohann comparou duas direções visuais e escolheu A em 26/10/2026. Depois pediu logo oficial Prymeira, ação Abrir/preparar discreta e remoção de Próximo retorno da aba Conversa. Refazer o painel inteiro com essa identidade e preservar as funcionalidades validadas. Prym é acompanhante visual das sugestões e estados; não um agente novo ou chat independente.

Escopo visual: cabeçalho e navegação, identidade do contato, editor e ações, filas, paginação, conexão, estados vazios/carregamento/erro/sucesso e movimento. Arte original extraída do PDF fornecido, sem gerar outro personagem. Dados fictícios somente em testes/prévias. Regressões: preservação de rascunhos, identidade canônica, revisão do follow-up, cancelamento por ação manual e ausência de envio.

Yohann também perguntou por conexão persistente ao fechar a aba. Investigar e implementar login de extensão com a integração oficial Clerk se os requisitos de configuração puderem ser atendidos. Não prometer persistência com uma cópia do JWT de um minuto. Registro de origem/permissões sensíveis será uma etapa concreta e revisável separada se necessária.
