# IA de apoio no chat - piloto assistido

## Decisão aprovada

O vendedor pede uma sugestão, conversa em privado com a IA, coloca a resposta no campo de mensagem, edita e envia pelo fluxo normal do Talk. A IA não envia mensagens nem executa ações comerciais sozinha. O histórico das sugestões e das alterações serve para revisar o agente posteriormente, sem aprendizado ou alteração automática de regras.

O usuário aprovou esse formato em 06/09/2026. O recurso será genérico para qualquer empresa; Villefer será o primeiro piloto. Associação do chip, canal e vendedor permanece a cargo do usuário. Nenhum canal de produção será ativado ou alterado como parte da elaboração desta especificação.

## Contexto verificado

- `apps/web/src/features/inbox/InboxPage.tsx` contém a conversa, o composer e o painel lateral de contato. `handleSendMessage` é o fluxo existente de envio manual.
- `apps/api/src/modules/assistant/assistant.service.ts` gera sugestões simuladas; esse comportamento não deve ser apresentado como IA real.
- O runtime de agentes contém seleção de conhecimento, regras do agente e tratamento de mídia, mas também caminhos que executam ações. O copiloto reutilizará preparação de contexto e o provedor, sem chamar o fluxo executor.
- Há logs de ações de IA e controles de conversa. Logs simulados existentes permanecerão distinguíveis dos novos registros reais.
- Testes publicados do agente Villefer não substituem o piloto real: transporte WhatsApp, associação do canal e tomada de controle humana ainda precisam ser verificados.

## Escopo da primeira versão

### 1. Configuração segura do piloto

- Configuração explícita por canal, dentro do workspace: modo assistido e agente usado nas sugestões. Somente proprietário/gestor pode configurá-la.
- O agente precisa existir no mesmo workspace. Importar o pacote não ativa disparos automáticos.
- Canais existentes preservam o comportamento atual. Somente o canal escolhido para o piloto entra em modo assistido.
- O backend bloqueia respostas autônomas do agente nesse canal, inclusive jobs já enfileirados, retries e ações automáticas do agente. O bloqueio é revalidado imediatamente antes de qualquer envio do agente, não apenas na interface.
- A habilitação sinaliza automações ou campanhas independentes existentes no canal. O modo assistido não será anunciado como bloqueio de todos os disparos externos; ativar o piloto exige revisar esses caminhos separadamente.

### 2. Uso dentro da conversa

- Área **IA de apoio**, junto aos detalhes do contato; no celular, painel acessível por botão sem reduzir permanentemente a conversa.
- Aviso permanente: **Privado. Nada é enviado ao cliente por aqui.**
- Botão **Sugerir resposta**, sem geração automática a cada mensagem recebida.
- A sugestão usa o agente configurado, suas fontes autorizadas e o histórico disponível da conversa atual. Limites de contexto devem ser explícitos; não alegar leitura integral quando o histórico foi cortado.
- Campo privado **Orientar a IA**, para pedidos como “seja mais direto” ou “a medida já foi informada”. Cada nova geração é explícita e cria uma versão, preservando as anteriores.
- Botão **Usar no campo de mensagem** copia a sugestão para o composer; não envia. Se houver rascunho escrito, pede confirmação antes de substituí-lo.
- O vendedor altera e envia pelo botão normal. Pode ignorar a IA e escrever do zero.
- Sem conversa selecionada ou sem agente configurado, mostrar estado explicativo. Não produzir uma resposta simulada como alternativa silenciosa.

### 3. Contexto, privacidade e limites

- Histórico carregado pelo servidor com workspace, conversa e permissões do usuário autenticado; não confiar em IDs ou transcrições arbitrárias fornecidos pelo navegador.
- Conversa privada vinculada à conversa comercial e ao agente, acessível somente a usuários autorizados para aquela conversa. Não é um canal secreto entre funcionários; gestor autorizado pode revisá-la. Nada dela é transmitido ao WhatsApp.
- Instruções de clientes e anexos são dados, nunca regras do agente. Orientações do vendedor não autorizam acesso a outros clientes nem substituem políticas da empresa.
- Reaproveitar os leitores de PDF, imagem e áudio e suas restrições. Falha ou ausência de conteúdo é visível ao vendedor; não inventar o conteúdo de anexos.
- Usar o provedor já configurado para o workspace. Não exportar dados para novos serviços. Evitar conteúdo integral ou credenciais em logs operacionais.
- Uma geração em andamento por contexto; duplo clique não duplica chamadas. Limites de tamanho, duração e histórico privado são aplicados no servidor, com indicação quando o contexto não couber.

### 4. Sugestões desatualizadas e envio

- Cada geração registra a revisão do agente e o marco das mensagens usadas como contexto.
- Nova mensagem recebida/enviada ou troca do agente torna a sugestão desatualizada. A interface avisa e exige nova geração ou confirmação explícita de revisão antes de usá-la.
- Trocar de conversa cancela/invalida a exibição da geração anterior. Resultado atrasado nunca preenche outra conversa ou seu rascunho.
- Falha ou timeout de IA preserva o rascunho e permite atendimento manual. Não existe fallback de envio autônomo.
- Vendedor continua responsável por confirmar estoque, preço, prazo e condições não autorizadas na base.

### 5. Registro das correções

Guardar, com escopo de workspace/conversa e trilha do usuário autenticado:

- Agente e revisão de configuração, marco do contexto e data da geração.
- Sugestão original, revisões sugeridas e orientações privadas do vendedor.
- Versão colocada no composer e texto final efetivamente submetido ao envio.
- Identificador da mensagem de saída e seu estado: aceito para envio, enviado ou falhou. Copiar para o composer não significa enviar; envio aceito não comprova entrega.
- Relação entre sugestão e envio validada no servidor. Uma tentativa com retry não cria exemplos duplicados.

Histórico simples de revisão mostra **Sugestão da IA / Mensagem enviada / Orientação do vendedor**, com indicação de aprovado sem mudança, editado ou ainda não enviado. Se o vendedor descartar a sugestão e escrever algo sem vínculo, não atribuir esse envio à IA.

Gestores podem consultar os exemplos do workspace. Isso é material de revisão: não modifica prompt, FAQ, catálogo, memória global ou políticas automaticamente. Transformar uma correção em regra geral fica fora desta versão e exige validação posterior.

## Organização da implementação

- **Serviço de sugestões:** prepara contexto, chama o provedor e persiste versões; não recebe dependência do executor de ações/envio.
- **Modo assistido por canal:** aplicado nos pontos de despacho e envio dos agentes e na interface de configuração.
- **Painel da conversa:** componente próprio para sugestões e orientações, evitando aumentar desnecessariamente o `InboxPage`.
- **Vínculo com o composer/envio:** identificador de versão e validação da conversa no endpoint existente; o texto final vem do envio autenticado, não de um evento de analytics enviado à parte.
- **Histórico de revisão:** registros próprios ou extensão tipada do log existente, com relações explícitas para conversa, agente, usuário e mensagem. Não inferir relações somente pelo texto ou por IDs soltos em JSON.

## Fora do escopo

- Resposta ou follow-up automático durante o piloto.
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

## Registro do processo

- [x] Explorar código e evidências do piloto existente.
- [x] Comparar sugestão automática com geração por botão; usuário escolheu botão.
- [x] Aprovar o fluxo funcional e o registro de alterações, sem envio automático.
- [x] Documentar decisões e revisar isolamento, escopo, consistência e falhas.
- [ ] Revisão desta especificação pelo usuário.
- [ ] Elaborar plano de implementação após a revisão.

Não foi necessário decidir um novo layout visual nesta etapa; a implementação seguirá o painel lateral e os padrões existentes do Talk. Esta especificação não afirma que o recurso já está implementado ou publicado.
