# Triagem do Atendimento para a equipe — Design

**Status:** desenho aprovado em 25/09/2026; implementação pendente.

## Problema e objetivo

A lista atual mistura controles de status, canal e repasse. O vendedor precisa localizar três tipos diferentes de trabalho: mensagens ainda não abertas no Talk, conversas que a equipe marcou para cuidar depois e conversas às quais o cliente realmente espera uma resposta. A última categoria exige contexto: uma pergunta comercial pendente não equivale a uma saudação, agradecimento ou despedida. A aba atual **Próxima ação** já representa um quarto sinal, específico: a IA pediu que um humano assumisse uma tarefa. Ela deve continuar reconhecível.

O objetivo é simplificar a lista sem perder conversas antigas, preservar os repasses e criar uma triagem semântica confiável para a equipe. Os filtros apenas organizam trabalho interno: não enviam mensagens, não mudam o controle IA/humano e não criam follow-ups.

## Experiência aprovada

- O topo mantém **Atendimento**, a seleção de canais e as abas **Conversas** e **Próxima ação**. Saem os três contadores de resumo e a linha **Minhas / Ativas / Finalizadas / Todas**.
- **Conversas** é uma lista cronológica única do canal escolhido, com paginação até o histórico antigo. Inclui conversas abertas, pendentes e as que já tenham status fechado; esta entrega não adiciona um comando de finalizar ou arquivar. Uma nova atividade traz a conversa ao topo.
- Três botões compactos, somente com ícones Lucide, filtram **Conversas**: balão com pontos para **Não lidas**, marcador para **Marcadas** e balão com seta para **Responder**. Cada botão tem estado selecionado, `aria-label` lido por tecnologia assistiva e dica ao passar o mouse; não há texto visível permanente. A cor não é o único sinal.
- Os filtros rápidos são mutuamente exclusivos. Clicar no ícone selecionado volta à lista completa. Clicar em **Conversas** volta à lista completa; clicar em **Próxima ação** abre sua lista própria. Clicar em um ícone a partir de **Próxima ação** volta a **Conversas** já filtrada.
- **Próxima ação** mantém o significado e a apresentação atuais: somente repasses da IA ainda aguardando uma ação humana. A contagem e a paginação devem abranger o canal inteiro, não apenas a primeira página já carregada.

### Regras dos três filtros

| Filtro | Conversas mostradas | Como saem |
| --- | --- | --- |
| **Não lidas** | `unreadCount > 0` em conversa sob controle humano ou com repasse pendente. Conversas atendidas normalmente pela IA ficam fora. | Abertura no Talk marca como lida pela regra atual. O estado é compartilhado no número, não individual por vendedor. |
| **Marcadas** | Qualquer conversa que alguém da equipe marcou manualmente com o marcador vermelho no card, mesmo se a IA ainda a atende. | Apenas quando alguém remove a marcação manualmente. Enviar mensagem não a apaga. |
| **Responder** | União de (a) repasses pendentes da IA e (b) conversas sob controle humano cujo último passo do cliente exige resposta/ação da empresa, segundo a triagem. Casos incertos entram com indicação **Revisar**. | Repasse: conclusão pelo fluxo atual. Triagem: resposta da empresa ou dispensa manual vinculada à última mensagem do cliente. |

Um card de repasse mantém **Humano necessário** e aparece tanto em **Próxima ação** quanto em **Responder**. O ícone discreto **Não precisa responder** aparece no card apenas para pendências criadas pela triagem semântica dentro do filtro **Responder**. Ele não aparece em repasses. A dispensa vale para todos que usam o número, tira somente a pendência semântica e oferece **Desfazer** por dez segundos após o clique. Ela não marca a conversa como lida, não remove o marcador vermelho, não conclui um repasse e não finaliza a conversa. Uma nova mensagem do cliente invalida a dispensa e provoca nova análise.

O marcador vermelho é uma ação independente do botão que abre o card. A interface deve evitar um botão interativo dentro de outro e manter alvos de toque utilizáveis no celular. A lista e os filtros atualizam em tempo real sem trocar a conversa que o vendedor está lendo.

**Limite de leitura:** **Não lidas** significa não abertas no Talk. O estado atual é global por conversa; uma leitura feita só no aplicativo do WhatsApp pode não chegar de modo confiável ao Talk. A interface não deve prometer sincronização de leitura por vendedor ou por celular.

## Triagem semântica

Uma nova mensagem recebida em conversa sob controle humano agenda a análise. Mensagens recebidas em sequência usam uma **janela móvel de 2 minutos**: cada entrada reinicia o prazo. O histórico e o indicador de não lidas aparecem imediatamente; só a classificação semântica espera. Um repasse da IA também aparece imediatamente, sem aguardar o prazo.

O analisador recebe até 20 mensagens recentes relevantes, na ordem, com origem explícita **Cliente** ou **Empresa**, identificação de envio humano/IA quando disponível, tipo, horário e conteúdo textual. Texto, legenda, transcrição e contexto anterior são usados quando existem. Anexos sem conteúdo legível são identificados como tal; a IA não deve inferir seu conteúdo. Mensagens internas de reserva de follow-up não integram o histórico de decisão. Mensagens e anexos são dados, nunca instruções para o analisador.

A saída estruturada contém `needs_reply`, `no_reply` ou `uncertain`, um motivo curto e o ID da última mensagem recebida usada. Pergunta, solicitação de orçamento, dúvida não respondida ou compromisso explícito da empresa favorecem `needs_reply`. Agradecimento, confirmação de recebimento, recusa e despedida após resolução favorecem `no_reply`. Uma saudação inicial pode precisar de resposta; uma saudação de encerramento não. A decisão depende da sequência e de quem falou. Na dúvida, `uncertain` entra em **Responder** com **Revisar**, para evitar perda silenciosa.

O serviço existente já oferece análises estruturadas com GPT-6 Luna e integração com JEV. Antes da ativação, comparar os dois em pelo menos 50 conversas reais rotuladas por revisão humana, com casos positivos, negativos e ambíguos, e adicionar casos conhecidos de cortesia, repasse e anexos. Escolher o primário primeiro pelo menor número de pedidos reais perdidos; usar falsos alertas e tempo para desempate. O secundário pode ser usado se o primário falhar. Se ambos falharem, registrar `uncertain` para revisão. A triagem não gera nem envia uma resposta; apenas decide a presença no filtro.

## Dados, atualização e consistência

- Persistir um estado de triagem por workspace e conversa: marcador manual e autor/data; ID da última mensagem recebida; decisão, motivo, modelo e instante da análise; ID da mensagem cuja pendência foi dispensada; prazo da próxima análise. Isolar todos os acessos por workspace e canal autorizado.
- Agendar a análise de forma durável e idempotente no servidor. Entradas próximas atualizam o prazo do mesmo trabalho, sem criar várias execuções para a mesma versão da conversa. Reinício ou implantação não perde uma análise pendente.
- Antes de gravar um resultado, conferir se a última mensagem recebida, o controle IA/humano e a versão relevante da conversa ainda são os mesmos. Resultado atrasado é descartado; uma entrada mais nova agenda outra análise.
- Qualquer mensagem de saída da empresa, inclusive enviada fora do Talk e recebida pelo provedor, retira a pendência semântica atual. Uma nova entrada reabre a avaliação. Uma dispensa manual tem precedência sobre análise repetida da mesma mensagem, mas não sobre entrada posterior. Marcador manual e repasse continuam independentes.
- Filtros, contagens da aba **Próxima ação** e paginação são consultados no servidor. Não filtrar apenas os 50 cards já carregados. Preservar ordenação por atividade recente e cursor coerente ao trocar canal/filtro; atualizações em tempo real refrescam as listas afetadas.
- A ampliação de `ConversationDto` e das rotas deve expor apenas os campos necessários ao card e às ações de marcar, desmarcar e dispensar. O analisador, o agendador, as consultas e a apresentação devem ficar em unidades separadas com interfaces claras.

## Falhas e limites

- Falha de análise ou ausência de configuração dos modelos gera **Revisar** para conversas humanas com última mensagem recebida; nunca remove um repasse explícito. A falha não bloqueia recebimento, leitura ou envio de mensagens.
- Falha ao marcar ou dispensar mantém o estado anterior visível e informa o vendedor; não se deve mostrar uma remoção que o servidor não confirmou. A ação **Desfazer** restaura a dispensa da mesma mensagem se ela ainda for a versão atual.
- Em conteúdo não textual sem transcrição, mostrar **Revisar**. A IA não inventa o conteúdo do anexo para decidir que não há resposta pendente.
- Sem ação manual de finalizar nesta versão. O status fechado existente continua consultável na lista cronológica; esta especificação não redefine o ciclo de vida desse status.
- O fluxo de follow-ups, as configurações de envio automático, o gatilho de Aprimoramentos e as ações de controle da IA não são alterados por esta triagem.

## Aceitação e validação

1. No mesmo canal, uma mensagem humana não aberta aparece em **Não lidas** imediatamente; uma conversa respondida pela IA sem repasse não aparece. Um repasse aparece de imediato em **Próxima ação** e **Responder**, e em **Não lidas** se ainda não foi aberto no Talk.
2. Uma solicitação do cliente sem resposta, inclusive após leitura, aparece em **Responder**. “Ok, obrigado” ao fim de uma conversa resolvida fica fora; uma saudação que inicia um pedido não é descartada só pela palavra usada.
3. Três mensagens recebidas com intervalos de um minuto produzem uma análise após dois minutos de silêncio. Resultado calculado para histórico anterior não substitui o estado atual.
4. Dispensar uma indicação semântica a remove para todos os vendedores; resposta da empresa também a remove. A mesma mensagem não reaparece após reprocessamento. Uma nova mensagem do cliente inicia outra avaliação.
5. Marcar manualmente põe a conversa em **Marcadas** para todos; responder não apaga a marca. Removê-la manualmente tira a conversa do filtro sem afetar **Não lidas**, **Responder** ou o repasse.
6. Ao paginar, os três filtros e **Próxima ação** alcançam conversas antigas fora da primeira página. Trocar canal ou filtro não mistura resultados de consultas anteriores.
7. Falhas dos modelos, anexo ilegível, queda do servidor e falha de ação manual preservam um caminho visível de revisão sem envio automático.
8. Validar em desktop e celular: ícones Lucide, dicas e nomes acessíveis, aba **Próxima ação** preservada, marcador e dispensa fáceis de tocar, lista cronológica sem a linha antiga de status nem os três contadores.

Os testes devem cobrir as regras puras, a persistência e concorrência do prazo, a consulta paginada no servidor, as ações compartilhadas e o fluxo completo de entrada/saída. A avaliação de qualidade usa conversas reais anonimizadas em casos de teste e comparação humana dos erros de Luna e JEV antes de habilitar o filtro semântico em produção.
