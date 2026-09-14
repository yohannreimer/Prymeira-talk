# Espera de mensagens e nome do contato

Mudança solicitada em 14/09/2026: de dois para cinco segundos sem nova mensagem antes de gerar sugestões. Mantido teto de dez segundos para agrupar mensagens contínuas. Não é prazo de resposta do modelo. Sem alteração de envio manual, controle humano ou prompt.

Novo cartão de contato na conversa com nome, telefone, canal e botão Editar/Adicionar nome. Formulário inline com Salvar/Cancelar, Enter para salvar, Escape para cancelar, foco restaurado, limite de 200 caracteres e erro sem perder o texto. Usa PATCH /contacts/:contactId existente, sem tocar telefone ou outros campos. Atualiza todas as conversas desse contato no estado local e mantém eventos contact.updated. O cartão é recriado ao trocar contato para não transportar uma edição pendente.

Verificação local: teste do debounce falhou com 3000 versus 6000 e passou após a mudança. Teste do cartão falhou sem implementação e passou depois. Suíte isolada: API 830 aprovados/10 ignorados; web 116 aprovados; shared 51 aprovados. Typechecks e builds aprovados (aviso preexistente de bundle web grande).

Teste no navegador com componente real e persistência simulada, sem WhatsApp: edição e gravação, nome vazio rejeitado sem chamada, estado Salvando com controles bloqueados, falha mantendo o texto, troca de contato limpando edição pendente, Escape cancelando e preservação do rascunho da mensagem. Nenhum contato real renomeado como teste. O harness temporário foi removido; estes testes de navegador não provam a rede de produção.

Checkout isolado baseado no commit publicado 3ae8c4a. Não inclui alterações experimentais de runtime/mídia/prompt presentes no checkout Assisted Pilot.

## Publicação e verificação em produção

Commit de código `3a4a7ed86719c6b18c14f84aa474b18b29e4d031`, workflow `34879492778` concluído com sucesso para API e web. Atualizados somente esses dois serviços no Portainer; sem alteração de schema/migração, credenciais ou demais serviços. Imagens anteriores preservadas: API `3ae8c4ab515306971eeca60b66112a96ef90df34`; web `8b8dff0745c5fa30f7e52281739b64a35157c075`.

API nova task `pyc9itfwdzwbb94g4jnmqom82`, container `8524f94617093a29e7c9eff333c328ab517bd1429549dfc1e0b5b2f0b8f99bbe`. SHA-256 do bundle em produção `ef46441f2d2e8afc1d0ea993de7c629bb7a9641343390c83eec1204cd0e5dec1`. Função publicada verificada como `Math.min(lastInboundMs + 5e3, firstPendingMs + 1e4)` e executada isoladamente com resultado 6000 para entradas 1000/1000. O primeiro verificador textual procurou a string 5000 e foi corrigido para testar o valor, pois o empacotador usa notação 5e3. O build de produção local específico (`build:prod`) também foi executado e aprovado; o comando genérico API build somente faz typecheck.

Web nova task `vkqmf3gm2rz3u2131zbj6w759`. Interface publicada mostrou Adicionar nome, abriu o campo Nome do contato e Salvar nome; cancelado sem gravar cliente real. Verificação na sessão antiga disponível (Diogo), não na sessão do usuário vendas5. O componente é compartilhado pelos canais. Após a troca, health e ready retornaram 200; ocorreu um 502 transitório durante o reinício da API, seguido de recuperação. As duas configurações do workspace vendas5 continuam em sugestões automáticas e o agente Junior inativo, sem envio autônomo.

## Complemento do histórico e nomes

Workspace vendas5 `42e336e1-4ba8-4299-ba6d-8e2a01eef6cb`. Carga anterior: 355 mensagens Vendas 5 e sete Geral. A primeira fonte tinha omitido LIDs sem telefone comprovado. Instâncias antigas Junior Villefer e Villefer Geral, conferidas com o mesmo ownerJid de suas conexões novas, fornecem remoteJidAlt para recuperar os vínculos. Leitura paginada em duas passagens convergentes do mesmo intervalo 09/09/2026 17:27:49.160Z a 14/09/2026 17:27:49.160Z. Sem combinação por nome.

Complemento aplicado: **137 mensagens / 23 conversas novas no Geral**, **13 mensagens / uma conversa nova no Vendas 5**. Dezessete mídias recuperadas como bytes; isto não significa leitura/transcrição por IA. Zero erros, zero mensagens identificadas faltantes no audit posterior; as 150 datas originais e ingestedAt verificadas. No instante da aplicação, deltas zero para envios, execuções, sugestões, estados e campos das conversas existentes. Depois houve atividade real do usuário/canal, incluindo um envio aprovado; não atribuir essa ação ao importador, que não utiliza transporte nem agendador.

Após complemento: Geral com 28 conversas totais (26 do conjunto histórico), 27 com nome; Vendas 5 com 36 totais, 20 com nome. Um nome vazio existente preenchido com evidência explícita da origem. Nomes já cadastrados preservados, inclusive contra concorrência. Nomes nos contatos novos vieram de pushName de mensagem recebida; nunca do nome do próprio vendedor em mensagem enviada. Não inferido Lucas somente a partir da saudação do vendedor na captura.

Pendente: **43 mensagens / sete identificadores do Vendas 5** continuam sem telefone comprovado. Não importados como números falsos. Tentativa adicional cruzando IDs de mensagens em 7.800 registros antigos e 7.040 da nova instância não encontrou pontes com mesmo timestamp/autoria/conteúdo. Geral não tem identificadores pendentes no conjunto selecionado. Histórico futuro e suporte permanente a LID são trabalhos distintos; esta operação é uma carga inicial segura.

Evidência privada da carga anterior no PostgreSQL large object OID 26985 (178.345 bytes, 12 arquivos). Complemento e scripts no **OID 27018**, 176.420 bytes, 17 arquivos, SHA-256 `5b1a63f69221304b0ba19ceedacb940a615ba968ff745b5820523f7b9260bd1a`. Compressão gzip JSON com leitura de retorno e hash verificados antes de substituir o container. Inclui fontes, aliases, estados anteriores, auditorias, nomes e verificações. Mesma VPS, não backup externo; não restaurar registros sobre atividade posterior. Dados privados não incluídos no Git.
