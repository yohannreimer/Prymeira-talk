# Follow-ups contextuais de conversa — design

## Objetivo

Criar uma fila operacional de follow-ups para recuperar conversas que esfriaram sem enviar mensagens irrelevantes. A fila acompanha tanto qualificações pausadas quanto propostas ou negociações humanas sem resposta.

O sistema deve preservar o controle humano: follow-ups de conversas ainda sob responsabilidade do agente podem ser automáticos; follow-ups de conversas sob controle humano viram sugestões para o vendedor revisar e enviar.

## Escopo aprovado

- Dois tipos de acompanhamento:
  - **Qualificação pausada:** o agente solicitou uma pendência técnica, comercial, logística ou cadastral e o cliente não respondeu.
  - **Proposta/negociação parada:** uma mensagem humana relevante foi enviada e o cliente não respondeu.
- Cadência por horário útil de São Paulo: primeira tentativa após 6 horas úteis, segunda após 2 dias úteis e terceira após 4 dias úteis.
- Máximo de três tentativas por ciclo de conversa.
- Uma nova aba de Follow-ups no Talk, com fila de revisão e histórico de envios.
- JEV decide se ainda há motivo para acompanhar e qual é o objetivo do follow-up; GPT gera apenas o texto que será enviado ou apresentado como rascunho.

## Fora de escopo

- Reativar automaticamente uma conversa sob controle humano.
- Fazer o JEV afirmar estoque, preço, prazo, frete ou qualquer fato comercial sem fonte aprovada.
- Substituir o vendedor em negociação, proposta, exceção ou handoff.
- Criar um editor genérico de fluxos de automação como dependência deste recurso.

## Modelo operacional

Cada conversa elegível possui no máximo um follow-up ativo. O registro guarda:

- conversa, agente e responsável atual;
- tipo (`qualification` ou `human_commercial`);
- etapa da cadência (1, 2 ou 3) e horário calculado;
- versão/contexto que originou o agendamento;
- estado (`scheduled`, `review`, `sent`, `cancelled`, `skipped`, `expired`);
- motivo e classificação JEV;
- rascunho, texto efetivamente enviado e ações do usuário;
- timestamps, autor de envio e motivo de cancelamento/adiamento.

O agendador processa registros devidos em lotes idempotentes. Um bloqueio por registro impede duas execuções concorrentes.

## Elegibilidade e invalidação

Um candidato é criado ou reagendado quando uma conversa recebe mensagem relevante da empresa ou do agente. No horário devido, o worker lê o estado atual, não apenas o estado salvo no agendamento.

O follow-up é cancelado imediatamente quando ocorrer qualquer uma destas condições depois do seu contexto de origem:

- cliente envia nova mensagem;
- vendedor humano envia nova mensagem;
- conversa é encerrada;
- conversa entra em handoff ou muda para `human_controlled` quando o registro era automático;
- uma tentativa posterior já foi enviada;
- limite de três tentativas foi alcançado.

Uma conversa humana continua elegível para receber **sugestões** depois de uma mensagem do vendedor. Ela nunca recebe envio automático pelo módulo.

Antes de qualquer envio automático e antes de confirmar um envio manual, o backend valida novamente se o cliente ou vendedor respondeu. Se houve alteração, cancela o item e não envia a mensagem desatualizada.

## Decisão por IA

No vencimento de um follow-up, o sistema envia ao JEV a última janela de conversa e as fontes de conhecimento selecionadas. A decisão estruturada precisa indicar:

- se o follow-up ainda é necessário;
- objetivo: cobrar pendência técnica, retomar proposta, entender bloqueio, oferecer ajuda concreta, confirmar demanda ativa ou não acompanhar;
- rota: `automatic_send`, `human_review`, `cancel` ou `wait`;
- etapa comercial e sinais de risco.

Regras de rota:

- `automatic_send` só é possível em conversa `agent_allowed`, com qualificação ainda pendente e sem takeover humano.
- `human_review` é obrigatório em conversa `human_controlled`, proposta, negociação, exceção ou pedido que dependa do vendedor.
- `cancel` encerra o registro quando a conversa não exige contato adicional, já foi resolvida, foi perdida ou recebeu resposta.

Para `automatic_send`, o GPT recebe o prompt do agente, o objetivo JEV, a etapa e o contexto atual. O texto candidato passa pela auditoria JEV antes de ser enviado. Para `human_review`, o GPT produz rascunho contextual e a auditoria JEV o valida antes de exibi-lo. O usuário pode editar o rascunho; o envio manual continua sendo uma mensagem humana e não reativa a automação.

## Cadência e calendário

O cálculo usa a configuração de follow-up do agente, com fallback para Villefer:

| Etapa | Atraso |
| --- | --- |
| 1 | 6 horas úteis |
| 2 | 2 dias úteis |
| 3 | 4 dias úteis |

O calendário usa `America/Sao_Paulo`, segunda a sexta, 08:00–18:00, salvo configuração específica do agente. Cada nova mensagem relevante reinicia ou invalida a etapa anterior; os atrasos nunca são calculados em horas corridas fora da janela útil.

## Experiência no Talk

A nova aba **Follow-ups** terá quatro filtros:

- **Para revisar:** sugestões de conversas humanas, com motivo, etapa, vencimento e rascunho.
- **Agendados:** acompanhamentos automáticos ainda não vencidos.
- **Enviados:** histórico, texto final, canal, horário e etapa.
- **Cancelados:** motivo de cancelamento e evento que o causou.

Cada item abre o histórico da conversa e oferece ações adequadas ao estado:

- enviar;
- editar e enviar;
- adiar pelo próximo horário útil configurado;
- cancelar;
- marcar como não acompanhar.

Se o item mudar enquanto estiver aberto, a interface informa que o contexto foi atualizado e impede o envio do rascunho antigo.

## Integração com controles existentes

O recurso usa o estado de conversa existente:

- `agent_allowed`: permite apenas o fluxo automático de qualificação.
- `human_controlled`: bloqueia JEV/GPT de enviar automaticamente e produz somente sugestões revisáveis.
- `request_handoff`: cancela qualquer follow-up automático pendente e conserva apenas a linha do tempo para o vendedor.

O recurso é independente da fila de respostas pendentes do agente e do canvas de automações. Essa separação evita que debounce de resposta imediata seja confundido com acompanhamento comercial de horas ou dias.

## Segurança, observabilidade e testes

- Idempotência por conversa e etapa impede mensagens duplicadas.
- O worker trava o registro, revalida a versão da conversa e só então envia.
- Todas as decisões JEV, fontes selecionadas, rascunhos, auditorias, cancelamentos e envios são auditáveis.
- Métricas: elegíveis, sugeridos, enviados, cancelados por resposta, adiados, conversões por etapa e taxa de revisão humana.
- Cenários essenciais de teste: resposta do cliente antes do vencimento, mensagem humana após sugestão, handoff durante agendamento, segunda execução concorrente, fora do horário útil, terceiro follow-up, conversa encerrada e rascunho editado antes de enviar.

## Critério de sucesso

Uma conversa parada recebe no máximo o acompanhamento apropriado à sua etapa e ao seu dono atual. Clientes que já responderam nunca recebem follow-up antigo; vendedores controlam todos os follow-ups de suas conversas; a aba torna cada envio, sugestão e cancelamento rastreável.
