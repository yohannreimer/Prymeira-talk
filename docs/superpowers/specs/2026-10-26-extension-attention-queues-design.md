# Filas do Talk no WhatsApp Web

## Resultado autorizado

O usuário pediu as filas Follow-ups e Humano necessário dentro da extensão, usando a mesma conta e o mesmo número verificado do Talk. Após discutir envio pelo Talk, escolheu explicitamente: clicar no follow-up abre a conversa no WhatsApp Web e coloca o texto no campo; o vendedor revisa e envia pelo próprio WhatsApp. Design e marca ficam para depois. Execução neste chat, sem subagentes.

## Fluxo

Três abas: Conversa, Follow-ups e Humano necessário. Follow-ups tem os estados Para revisar (padrão e contador vermelho), Lembretes e Agendados. Filas paginadas do canal selecionado, com contadores do escopo completo e atualização periódica. Humano necessário reutiliza a regra persistida do inbox e mostra o motivo; abrir um item não conclui a ação humana.

Clicar em um follow-up em revisão revalida o item e abre seu telefone no WhatsApp Web. Quando a conversa aberta é comprovada pelo resolver existente, a extensão confere novamente ID, versão e rascunho do acompanhamento, então insere o texto no campo vazio. Não envia nem pressiona Enter. Lembretes internos e agendados abrem a conversa sem preparar envio. Texto ausente, campo ocupado, mensagem ainda não sincronizada, identidade ambígua, sessão trocada e navegação manual interrompem a preparação com aviso.

O envio nativo será observado pelo fluxo de sincronização existente do Talk. A extensão não marca o acompanhamento como enviado antes de comprovação e não cria um segundo disparo. Nenhuma mensagem real será enviada como teste.

## Limites e acesso

API somente de leitura para filas e destino. Workspace vem da autenticação; canal deve estar conectado e com número verificado igual ao WhatsApp aberto. Atendentes veem somente conversas atribuídas. Excluir grupos, contas/canais arquivados, conversas encerradas/aposentadas e itens inativos. Humano necessário respeita ações já concluídas e a visibilidade do inbox. Cursores precisam pertencer ao mesmo escopo/filtro.

Comandos da ponte continuam numa allowlist; sem URLs, tokens ou endpoints fornecidos pelo painel. Navegação constrói URL fixa de WhatsApp Web com telefone validado no servidor. Preparação exige uma intenção efêmera iniciada por clique, vinculada à janela, aba, conta, canal, conversa, revisão e prazo. Outra navegação, digitação, aba ativa ou conta revoga a intenção. Rascunhos nativos nunca são sobrescritos. Sugestões continuam com as proteções existentes.

## Implementação e validação

DTOs mínimos compartilhados. Serviço separado de filas reaproveita inboxHandoffWhere e resolveAssistantActor. Backend não ganha rota de envio. Worker separa autorização de fila, navegação e inserção; observador envia apenas cancelamentos de intenção, sem conteúdo digitado. Painel ganha componente de filas e mantém detalhes da conversa.

Testes: isolamento por workspace/canal/atribuição, cursores e itens retirados; paridade da regra humana; navegação só para destino autorizado; troca de conta/aba e digitação cancelam preparação; conversa errada, revisão alterada e campo ocupado bloqueiam inserção; clique válido abre e prepara sem envio; edição do vendedor é preservada. Validar builds, typecheck, Chromium com extensão real e rotas simuladas; CI exato antes da publicação.
