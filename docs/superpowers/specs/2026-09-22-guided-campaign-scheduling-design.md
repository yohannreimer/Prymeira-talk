# Disparos guiados com agendamento real

## Objetivo e decisão aprovada

Substituir, para disparos por canal Evolution não oficial, o editor técnico atual por um fluxo compreensível para operadores não técnicos. O usuário aprovou três etapas: **Destinatários**, **Mensagem e horário** e **Revisar e enviar**. Um rascunho nunca envia por si só. A ação final ativa uma fila persistente, que pode começar agora ou numa data futura e respeita de fato os intervalos, pausas e janela de horário escolhidos.

O desenho visual aprovado está na sessão `.superpowers/brainstorm/14217-1790119766/` (arquivos ignorados pelo Git). Este documento é a fonte de verdade para a implementação; os nomes e números mostrados nos mockups são ilustrativos.

## Escopo

- O novo fluxo cobre campanhas criadas em Disparos e rascunhos originados em Leads, quando o envio é pelo canal Evolution não oficial. O caminho de templates Meta permanece funcional no editor atual e não recebe mudanças comportamentais nesta entrega.
- Contatos vindos de Leads são identificados como **Leads**, não como “Excel/CSV”. Planilhas importadas e boards continuam disponíveis como outras origens.
- A experiência comum oferece um canal de saída conectado por campanha. O suporte atual a múltiplos canais não deve ser removido dos dados existentes; campanhas legadas com múltiplos canais seguem legíveis, e sua ativação deve passar pelas mesmas salvaguardas de verificação e fila. Seleção de múltiplos canais na nova interface fica fora deste escopo.
- Cada workspace acessa apenas as próprias campanhas, destinatários, listas, canais e verificações.

## Etapa 1: destinatários

1. Mostrar quantos leads/contatos foram selecionados originalmente, quantos telefones únicos têm WhatsApp confirmado pela Evolution e quantos ficarão fora. Exibir nomes e motivos agrupados e individualmente: sem telefone válido, sem WhatsApp, ainda não verificado, falha temporária ou duplicado.
2. **Verificar novamente** inicia a verificação de disponibilidade sem enviar mensagem. Enquanto houver verificação pendente, o avanço para ativação não é permitido. Uma falha temporária não é tratada como “sem WhatsApp”; a pessoa pode tentar novamente.
3. Só o estado `available` para o telefone normalizado atual torna um destinatário elegível a envio real. Telefone apenas bem formatado, estado antigo de outro número ou resultado inconclusivo não bastam. Ao ativar, o servidor refaz a elegibilidade e congela os telefones/contatos que compõem a fila. Antes de cada entrega, confirma a disponibilidade do mesmo número: indisponível é ignorado com motivo; indisponibilidade da Evolution pausa o lote sem enviar esse item.
4. Se nenhum número estiver elegível, permitir salvar o rascunho, mas bloquear ativação. Se a contagem mudar entre revisão e ativação, invalidar a confirmação e exigir nova revisão.
5. Rascunhos novos criados em Leads guardam a contagem da seleção original e os motivos de exclusão, sem criar contatos para telefones inválidos. Rascunhos antigos que só armazenam as linhas importadas mostram apenas o número conhecido e informam que a seleção original não está disponível; não inventam “26 selecionados”.

## Etapa 2: mensagem, horário e ritmo

- Mostrar o texto em linguagem comum e uma prévia preenchida para um destinatário, indicando claramente que variáveis e mensagens alternativas são opções avançadas. Campos vazios ou variáveis não resolvidas bloqueiam a ativação. O operador pode voltar e editar sem perder a seleção.
- Escolha explícita: **Assim que eu confirmar** ou **Agendar para dia e hora**. O horário e o fuso da campanha aparecem por extenso; padrão `America/Sao_Paulo`, editável quando o workspace usa outro fuso. Data no passado é inválida. Se a hora escolhida cair fora da janela, mostrar antes da confirmação o primeiro horário efetivo.
- Preset inicial **Padrão moderado**: intervalo novo e independente entre **120 e 300 segundos** entre tentativas reais de mensagem; após cada **20 tentativas reais**, pausa nova e independente entre **900 e 1200 segundos** antes da próxima; números ignorados antes de chamar o provedor não contam nesse grupo. Envios somente entre **09:00 e 20:00**, no fuso armazenado na campanha. A interface mostra esses valores em minutos e permite **Personalizar** todos eles. Não usar “à prova de ban” nem prometer segurança absoluta.
- A programação usa sorteios independentes dentro dos intervalos configurados e persiste os valores sorteados por destinatário. Os instantes planejados podem ser empurrados para a frente por pausa, falha ou conflito com outra campanha do mesmo canal, mas os intervalos não são sorteados novamente depois de reinícios. Quando intervalo ou pausa atravessar 20:00, a fila espera o próximo dia às 09:00. A estimativa antes da ativação é uma faixa; depois, a pessoa vê o próximo envio planejado.
- Salvar preserva `draft` mesmo que uma data futura esteja preenchida. Somente a confirmação final muda o estado para `scheduled` ou `sending`.

## Etapa 3: revisão e ativação

- Mostrar numa tela curta: destinatários confirmados e excluídos, canal de saída, texto completo e prévia, início efetivo, fuso, janela diária, intervalo e pausa. O botão final diz **Agendar N mensagens** ou **Iniciar envio para N contatos**, conforme a escolha.
- Exigir confirmação explícita de que a pessoa conferiu destinatários e mensagem e tem autorização para esse contato. Registrar operador e instante da confirmação como trilha de auditoria; isso não é prova automática de consentimento.
- A ativação é uma operação idempotente com chave de requisição. O backend valida novamente canal, audiência, WhatsApp, texto, janela e data, então cria a fila persistente. Chamadas repetidas não duplicam destinatários nem enviam duas vezes. A rota legada de `send-real` não pode continuar como atalho síncrono que ignora a fila: ela deve usar a mesma ativação segura ou rejeitar o fluxo antigo de modo explícito.
- A confirmação da tela **não** executa um disparo em massa síncrono. Ela programa a fila; o primeiro item pode ficar disponível imediatamente se a opção for “agora” e o horário estiver dentro da janela.

## Acompanhamento e execução

- Após ativar, mostrar estados claros: **Agendado**, **Em andamento**, **Pausado**, **Concluído**, **Cancelado** ou **Precisa de atenção**. Mostrar próximo envio, total confirmado, enviado, pendente, ignorado e falhas, com motivo por contato. Evitar o jargão “resolver audiência”, “template” e “linhas” no caminho comum.
- **Pausar** impede novos envios, mas não desfaz uma chamada já iniciada. **Retomar** preserva os itens e a cadência, ajustando somente horários futuros. **Cancelar restantes** marca pendentes como cancelados; mensagens já enviadas permanecem no histórico. A UI explicita essa limitação antes da ação.
- Um worker persistente busca apenas destinatários vencidos de campanhas ativas, com reivindicação/lease transacional e isolamento por workspace. Um item não pode ser executado por dois workers. Campanhas simultâneas que usam o mesmo canal são serializadas pelo canal para não somar duas cadências independentes. Reinício do servidor preserva estado e horários. Falha de canal ou de disponibilidade da Evolution pausa o lote com ação de retentativa; número individual comprovadamente indisponível é ignorado. Uma resposta de envio ambígua (timeout depois de chamar o provedor), ou um lease expirado depois de iniciar a chamada ao provedor, entra em **Precisa de atenção** e nunca é reenviado automaticamente, para evitar duplicatas.
- Guardar por destinatário o canal, telefone normalizado, estado de verificação, horário planejado, horário de tentativa, resultado e identificador do provedor quando existir. A mesma mensagem enviada uma vez não pode voltar para `pending` após refresh, pausa, retry ou deploy.

## Modelo e migração

- Persistir um snapshot de audiência/origem/contagens, configuração de fuso e ritmo, escolha “agora/agendado”, confirmação e canal escolhido. Persistir destinatários antes do envio com estados de fila, lease e resultado. Adicionar estados de campanha `paused` e `canceled` (ou equivalentes mapeados sem ambiguidade).
- Migrações são aditivas e compatíveis com campanhas existentes. Rascunhos antigos não ativam automaticamente; campanhas com `scheduledAt` preenchido mas sem fila ativada continuam rascunhos legados até revisão explícita. Nunca interpretar o status antigo `scheduled` como autorização para enviar.
- Não guardar chaves Evolution no snapshot. Configuração de canal é resolvida com escopo do workspace na hora de enviar.

## Erros, acessibilidade e segurança

- Mensagens de erro dizem o que ocorreu e o próximo passo (“Não foi possível verificar 3 números. Tente novamente.”), sem exposição de dados internos. Progresso assíncrono não desaparece ao sair e voltar. Estados e botões têm rótulos acessíveis, foco visível e confirmação que não depende apenas de cor.
- O agendamento não é apresentado como proteção contra ban. O WhatsApp pode restringir contas por mensagens indesejadas e feedback negativo; a interface informa a necessidade de autorização e opt-out apropriados. Nenhum teste ou deploy de verificação pode enviar WhatsApp real sem ação humana explícita.
- Isolamento entre workspaces e permissão `campaign.manage` são verificados também nas novas rotas e no worker. Não permitir que parâmetros do cliente marquem um número como `available`.

## Critérios de aceite

1. Um operador não técnico consegue criar rascunho de Leads, ver seleção original versus destinatários confirmados, identificar exclusões e pré-visualizar a mensagem sem enviar nada.
2. Um telefone válido mas não confirmado pela Evolution não pode entrar num envio real, por UI nem por API. Falha temporária de verificação não é convertida em confirmação.
3. Salvar data futura sozinho não ativa campanha; a ativação agendada não envia antes do horário efetivo e nunca fora de 09:00–20:00 no fuso configurado.
4. Em testes com relógio e aleatoriedade controlados, intervalos ficam em 120–300 segundos, pausas em 900–1200 segundos a cada 20 contatos, e os horários persistidos sobrevivem a reinício.
5. Simular, confirmar repetidamente, atualizar a página, pausar/retomar ou executar dois workers em paralelo não duplica mensagens reais.
6. O operador vê contagens e motivos consistentes antes e depois da ativação, e pode pausar/cancelar somente o que ainda não foi enviado.
7. Os fluxos Meta e campanhas legadas continuam acessíveis; sem migração que envie campanhas antigas automaticamente.

## Fora de escopo

- Garantia de não bloqueio do número, aprovação automática de consentimento ou otimização de conteúdo para driblar políticas.
- Redesenho do envio por template Meta e seleção de vários canais na nova experiência guiada.
- Alteração no scraper, na pesquisa de Leads ou no mecanismo de importação de CSV, salvo metadados necessários à contagem e origem do rascunho.
