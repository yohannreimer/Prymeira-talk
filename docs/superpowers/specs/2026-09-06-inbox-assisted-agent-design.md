# IA de apoio no chat - piloto assistido

## Decisão aprovada

Enquanto a conversa não estiver em **Humano no controle**, cada nova mensagem do cliente dispara a preparação automática de uma sugestão privada. O vendedor pode enviá-la com um clique explícito, editar antes de enviar ou conversar em privado com a IA. Em **Humano no controle**, a geração para. A IA nunca envia mensagens nem executa ações comerciais sozinha. O histórico das sugestões e das alterações serve para revisar o agente posteriormente, sem aprendizado ou alteração automática de regras.

O usuário aprovou o modo assistido em 06/09/2026 e depois substituiu a geração somente por botão pela geração automática condicionada ao controle humano. A opção de geração sob demanda continua disponível como alternativa, mas não é o padrão deste piloto. O recurso será genérico para qualquer empresa; Villefer será o primeiro piloto. Associação do chip, canal e vendedor permanece a cargo do usuário. Nenhum canal de produção será ativado ou alterado como parte da elaboração desta especificação.

## Contexto verificado

- `apps/web/src/features/inbox/InboxPage.tsx` contém a conversa, o composer e o painel lateral de contato. `handleSendMessage` é o fluxo existente de envio manual.
- `apps/api/src/modules/assistant/assistant.service.ts` gera sugestões simuladas; esse comportamento não deve ser apresentado como IA real.
- O runtime de agentes contém seleção de conhecimento, regras do agente e tratamento de mídia, mas também caminhos que executam ações. O copiloto reutilizará preparação de contexto e o provedor, sem chamar o fluxo executor.
- Há logs de ações de IA e controles de conversa. Logs simulados existentes permanecerão distinguíveis dos novos registros reais.
- Testes publicados do agente Villefer não substituem o piloto real: transporte WhatsApp, associação do canal e tomada de controle humana ainda precisam ser verificados.

## Escopo da primeira versão

### 1. Configuração segura do piloto

- Configuração explícita por canal, dentro do workspace: modo assistido, agente e geração automática ou sob demanda. O piloto usa automática. Somente proprietário/gestor pode configurar o canal; a tomada de controle da conversa respeita as permissões existentes do vendedor.
- O agente precisa existir no mesmo workspace. Importar o pacote não ativa disparos automáticos.
- Canais existentes preservam o comportamento atual. Somente o canal escolhido para o piloto entra em modo assistido.
- O backend bloqueia respostas autônomas do agente nesse canal, inclusive jobs já enfileirados, retries e ações automáticas do agente. O bloqueio é revalidado imediatamente antes de qualquer envio do agente, não apenas na interface.
- A habilitação sinaliza automações ou campanhas independentes existentes no canal. O modo assistido não será anunciado como bloqueio de todos os disparos externos; ativar o piloto exige revisar esses caminhos separadamente.
- Reutilizar o controle humano da conversa como fonte de verdade: ao assumi-lo, cancelar gerações pendentes e impedir a publicação de resultados em andamento. Nenhuma nova geração, automática ou manual, é permitida até a liberação explícita desse controle. O envio manual comum continua disponível.
- Liberar o controle humano não habilita envio autônomo. No modo assistido automático, preparar apenas a resposta à mensagem mais recente ainda não atendida, se houver; não gerar respostas retrospectivas para todo o histórico.

### 2. Uso dentro da conversa

- Área **IA de apoio**, junto aos detalhes do contato; no celular, painel acessível por botão sem reduzir permanentemente a conversa.
- Aviso permanente: **Privado. Nada é enviado ao cliente por aqui.**
- Nova mensagem recebida prepara/atualiza a sugestão sem clique, mesmo que o vendedor não esteja com essa conversa aberta. Eventos duplicados não geram chamadas duplicadas. Usar fila por conversa, agrupando mensagens em sequência com 2 segundos de espera após a última, limitada a 10 segundos desde a primeira; toda mensagem nova entra no contexto mais recente.
- Em alternativa configurada sob demanda, o botão **Sugerir resposta** inicia a geração. Em ambos os modos o controle humano impede novas gerações.
- A sugestão usa o agente configurado, suas fontes autorizadas e o histórico disponível da conversa atual. Limites de contexto devem ser explícitos; não alegar leitura integral quando o histórico foi cortado.
- Campo privado **Orientar a IA**, para pedidos como “seja mais direto” ou “a medida já foi informada”. Cada geração, por mensagem recebida ou orientação do vendedor, cria uma versão e preserva as anteriores. Orientação privada não é enviada ao cliente.
- A sugestão fica em um cartão integrado ao chat. **Enviar resposta** exige clique do vendedor e usa o mesmo serviço de envio manual, com permissões, validação e idempotência. A existência da sugestão nunca dispara envio.
- **Editar no campo de mensagem** copia a sugestão para o composer; não envia. Se houver rascunho escrito, pede confirmação antes de substituí-lo. Nesse caso o vendedor envia pelo botão normal.
- O vendedor também pode ignorar a IA e escrever do zero. Uma mensagem enviada por ele invalida a sugestão anterior, mas não muda o estado de controle humano por conta própria.
- Sem conversa selecionada ou sem agente configurado, mostrar estado explicativo. Não produzir uma resposta simulada como alternativa silenciosa.

### 3. Contexto, privacidade e limites

- Histórico carregado pelo servidor com workspace, conversa e permissões do usuário autenticado; não confiar em IDs ou transcrições arbitrárias fornecidos pelo navegador.
- Conversa privada vinculada à conversa comercial e ao agente, acessível somente a usuários autorizados para aquela conversa. Não é um canal secreto entre funcionários; gestor autorizado pode revisá-la. Nada dela é transmitido ao WhatsApp.
- Instruções de clientes e anexos são dados, nunca regras do agente. Orientações do vendedor não autorizam acesso a outros clientes nem substituem políticas da empresa.
- Reaproveitar os leitores de PDF, imagem e áudio e suas restrições. Falha ou ausência de conteúdo é visível ao vendedor; não inventar o conteúdo de anexos.
- Usar o provedor já configurado para o workspace. Não exportar dados para novos serviços. Evitar conteúdo integral ou credenciais em logs operacionais.
- Uma geração em andamento por conversa; novos eventos marcam o contexto para atualização, sem publicar a versão superada. Idempotência por mensagem/evento e versão de contexto evita chamadas duplicadas. Limites de tamanho, duração, concorrência e histórico privado são aplicados no servidor, com indicação de limite atingido; não esconder falhas nem fazer retries ilimitados.

### 4. Sugestões desatualizadas e envio

- Cada geração registra a revisão do agente e o marco das mensagens usadas como contexto.
- Nova mensagem recebida torna a sugestão desatualizada e agenda sua atualização automática quando permitida. O botão de envio direto fica indisponível até a nova versão; texto já editado pelo vendedor permanece intacto, com aviso para revisão explícita no envio manual.
- Envio do vendedor ou troca de agente invalida versões anteriores. Backend revalida o marco do contexto no envio direto; se ficou antigo, devolve conflito em vez de enviar uma resposta superada.
- Trocar de conversa invalida apenas a exibição local; uma geração de outra conversa pode terminar e ficar salva nela. Resultado atrasado nunca preenche a conversa atualmente aberta ou seu rascunho.
- Marcar **Humano no controle** suspende imediatamente a fila e invalida os resultados em voo. Sugestões anteriores ficam no histórico, sem envio direto ou regeneração; rascunhos manuais são preservados.
- Falha ou timeout de IA preserva o rascunho e permite atendimento manual. Não existe fallback de envio autônomo.
- Vendedor continua responsável por confirmar estoque, preço, prazo e condições não autorizadas na base.

### 5. Registro das correções

Guardar, com escopo de workspace/conversa e trilha do usuário autenticado:

- Agente e revisão de configuração, marco do contexto e data da geração.
- Sugestão original, revisões sugeridas e orientações privadas do vendedor.
- Versão enviada diretamente ou colocada no composer e texto final efetivamente submetido ao envio.
- Identificador da mensagem de saída e seu estado: aceito para envio, enviado ou falhou. Copiar para o composer não significa enviar; envio aceito não comprova entrega.
- Relação entre sugestão e envio validada no servidor. Uma tentativa com retry não cria exemplos duplicados.

Histórico simples de revisão mostra **Sugestão da IA / Mensagem enviada / Orientação do vendedor**, com indicação de aprovado sem mudança, editado ou ainda não enviado. Se o vendedor descartar a sugestão e escrever algo sem vínculo, não atribuir esse envio à IA.

Gestores podem consultar os exemplos do workspace. Isso é material de revisão: não modifica prompt, FAQ, catálogo, memória global ou políticas automaticamente. Transformar uma correção em regra geral fica fora desta versão e exige validação posterior.

## Organização da implementação

- **Serviço de sugestões:** prepara contexto, chama o provedor e persiste versões; não recebe dependência do executor de ações/envio.
- **Modo assistido por canal:** aplicado nos pontos de despacho e envio dos agentes e na interface de configuração.
- **Agendamento de sugestões:** separado do agendamento de mensagens de saída; reage a entradas reais, respeita tomada de controle e só persiste/publica rascunhos privados. Nenhum job de sugestão chama o executor de ações ou transporte WhatsApp.
- **Painel da conversa:** componente próprio para sugestões e orientações, evitando aumentar desnecessariamente o `InboxPage`.
- **Vínculo com o composer/envio:** identificador de versão e validação da conversa no endpoint existente; o texto final vem do envio autenticado, não de um evento de analytics enviado à parte.
- **Histórico de revisão:** registros próprios ou extensão tipada do log existente, com relações explícitas para conversa, agente, usuário e mensagem. Não inferir relações somente pelo texto ou por IDs soltos em JSON.

## Direção visual

- Componente nativo do Inbox, seguindo tipografia, espaçamentos, cores e botões do Talk. Não criar uma tela separada, identidade visual paralela, gradientes chamativos ou excesso de selos de IA.
- No desktop, o painel lateral alterna **Contato** e **IA de apoio**, preservando acesso aos dados do cliente. No celular, o mesmo conteúdo abre em painel expansível acessível junto ao composer.
- Hierarquia curta: estado do controle, resposta sugerida e ação principal **Enviar resposta**; edição e orientação como ações secundárias. Histórico de versões fica recolhido por padrão.
- Estados claros: aguardando mensagem, preparando sugestão, pronta para revisão, atualizando, humano no controle e falha com opção de tentar novamente quando permitida.
- Não deslocar o foco do vendedor a cada atualização nem substituir texto digitado. Usar contraste acessível, foco visível, navegação por teclado e alvos de toque adequados.

## Fora do escopo

- Envio automático de resposta ou follow-up durante o piloto. Preparação automática de sugestões está dentro do escopo.
- Treinar/fazer fine-tuning automaticamente com cada edição.
- Alterar os agentes ativos da Villefer, disparar testes para clientes reais ou escolher o chip/vendedor.
- Prometer propostas comerciais, preços, estoque ou fechamento pelo agente de qualificação.
- Reformular todo o Inbox, construir um dashboard de treinamento ou aplicar regras específicas de aço no núcleo do produto.

## Critérios de aceitação

1. Pedir ou revisar sugestão não envia mensagem, transfere conversa, cria nota pública, muda etapa ou executa ferramenta do agente.
2. Modo assistido impede disparos autônomos do agente, inclusive trabalhos agendados antes de sua habilitação.
3. Vendedor usa, edita e envia; histórico vincula original, revisões, texto final e mensagem correta, sem duplicar registros em retry.
4. Conversas privadas, dados e sugestões de outro workspace/usuário não autorizado são recusados pelo servidor.
5. Nova mensagem, troca de conversa/agente, resposta atrasada, duplo clique e rascunho preexistente não causam sobrescrita ou envio indevido.
6. PDF/imagem/áudio legíveis podem compor o contexto; arquivo indisponível ou inválido gera aviso visível, sem conteúdo inventado.
7. Falha de provedor ou envio mantém o vendedor capaz de atender manualmente e registra o estado correto.
8. Alterações do vendedor não mudam configuração, conhecimento ou comportamento de outras conversas automaticamente.
9. Testes de API, UI e isolamento cobrem esses comportamentos; builds e typechecks passam antes da publicação.
10. Ensaio com chip e vendedor autorizados verifica sugestão, edição, envio único, anexos e ausência de resposta automática antes de atendimento real.
11. Nova mensagem recebida gera sugestão sem clique no modo automático; mensagens consecutivas/duplicadas não geram respostas obsoletas ou chamadas simultâneas para a mesma conversa.
12. Assumir controle humano antes do agendamento, durante a geração ou antes da publicação bloqueia a sugestão; liberar controle não envia nada ao cliente.
13. Envio direto da sugestão exige clique autenticado, versão atual e chave de idempotência; duplo clique e retries não duplicam mensagens. Campos de edição existentes são preservados.
14. Interface desktop e celular é verificada nos estados de geração, controle humano, edição e erro, sem cortes, sobreposições ou alteração inesperada de foco.

## Registro do processo

- [x] Explorar código e evidências do piloto existente.
- [x] Comparar sugestão automática com geração por botão; usuário revisou a escolha para automática no piloto, mantendo sob demanda como alternativa.
- [x] Aprovar o fluxo funcional e o registro de alterações, sem envio automático.
- [x] Documentar decisões e revisar isolamento, escopo, consistência e falhas.
- [x] Revisão da primeira especificação pelo usuário.
- [x] Revisão do ajuste para sugestões automáticas e controle humano.
- [x] Elaborar plano de implementação após a revisão.

Implementação local e evidências: `docs/assisted-inbox-pilot.md` e `artifacts/assistant-pilot/verification.md`. O usuário aprovou o visual e escolheu execução sequencial. Publicação e teste com chip real continuam pendentes.

O usuário solicitou design bonito e integrado ao Talk; a direção visual acima preserva os padrões existentes e será validada antes da implementação visual. Esta especificação não afirma que o recurso já está implementado ou publicado.
