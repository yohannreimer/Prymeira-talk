# Selo de controle no card de conversa — Design

**Status:** aprovado em 21/09/2026

## Objetivo

Fazer com que quem opera o Atendimento reconheça, sem abrir a conversa e sem aumentar o card, se uma ação humana está pendente, se um humano está no controle ou se a IA realmente está atendendo.

## Contexto

O card atual já usa quatro linhas úteis: nome, origem do canal, fila/responsável e prévia da última mensagem. Adicionar textos como “Humano está atendendo” ou “IA está atendendo” criaria altura e reduziria a leitura da fila.

O domínio já expõe os dados necessários em `ConversationDto`:

- `aiControlStatus`: `human_controlled` ou `agent_allowed`;
- `activeAgentSessionStatus`: inclusive `active`, `paused_by_human` e `handoff_requested`;
- `activeAgentName`;
- `handoffReason`.

Hoje o card em vermelho (`needs-human-attention`) é apenas o alerta de handoff ainda não reconhecido. Ao abrir a conversa, o estado local existente reconhece o alerta e remove o vermelho. O agente já havia pausado a própria atuação ao pedir handoff; abrir o card não deve atribuir a conversa a uma pessoa, enviar mensagens ou mudar o controle no servidor.

## Decisão de interface

Adicionar um selo circular de 18–20 px sobre o canto inferior direito do avatar do contato. O selo não cria linha, não altera a largura, não desloca horário, contador de não lidas, origem do canal ou fila.

O avatar é o único ponto estável e livre do card. O canto direito já contém horário e mensagens não lidas, e o ícone da linha “Fila geral” continua reservado para explicar a fila/responsável.

### Mapa de estados

| Prioridade | Condição | Card | Selo no avatar | Significado |
| --- | --- | --- | --- | --- |
| 1 | `showHumanAttention` é verdadeiro | Mantém o fundo/borda vermelhos atuais | Triângulo vermelho | A IA parou e há uma pendência humana ainda não reconhecida. |
| 2 | `aiControlStatus === "human_controlled"` | Visual normal | Pessoa azul | Humano está atendendo; a IA está pausada para a conversa. |
| 3 | `aiControlStatus === "agent_allowed"`, sessão `active` e agente ativo | Visual normal | Robô roxo | A IA está realmente atendendo esta conversa. |
| 4 | Demais combinações | Visual normal | Sem selo | Não há atendente automático ativo nem controle humano explícito a comunicar. |

A prioridade é intencional: enquanto o alerta não foi visto, ele precisa vencer o estado humano já definido pelo handoff. Depois de abrir a conversa, o alerta vermelho sai conforme o comportamento existente e o selo azul passa a comunicar o controle humano persistente.

“IA liberada” sem uma sessão ativa não recebe robô roxo. O robô significa que há IA atendendo de fato, não apenas que ela poderia ser liberada futuramente.

### Acessibilidade

O selo deve ter `title` e entrar no nome acessível do botão da conversa com uma frase curta:

- `Ação humana necessária`;
- `Humano está atendendo`;
- `IA está atendendo`.

O ícone SVG interno fica com `aria-hidden="true"`; cor nunca é o único sinal do estado. O tamanho visual pequeno não cria um alvo de toque novo: o card inteiro continua sendo o alvo de abertura.

## Arquitetura proposta

Nenhuma alteração de banco, API, transporte WhatsApp ou runtime do agente é necessária. A mudança é exclusivamente de apresentação e deriva os quatro casos do DTO já carregado pela fila.

1. Em `apps/web/src/features/inbox/conversation-display.ts`, criar uma função pura que receba uma conversa e `showHumanAttention`, devolvendo `attention`, `human`, `agent` ou `null`, com texto acessível associado.
2. Em `apps/web/src/features/inbox/InboxPage.tsx`, calcular o indicador depois do cálculo atual de `conversationNeedsHuman` e `showHumanAttention`, usar esse resultado no `aria-label` do botão e renderizar o selo dentro de `.conv-avatar-wrap`.
3. Em `apps/web/src/styles.css`, posicionar o selo de forma absoluta sobre o avatar, com variantes semânticas vermelho, azul e roxo. O card mantém seu `padding`, suas linhas e sua altura atuais.

Os ícones usam o mesmo conjunto Lucide já presente no Atendimento: `TriangleAlert` para pendência, `UserRound` para humano e `Bot` para IA.

## Limites desta entrega

Não faz parte desta entrega:

- mudar a regra atual de reconhecer o alerta ao abrir a conversa;
- atribuir automaticamente a conversa a quem abriu;
- persistir um novo “visto por” ou criar uma auditoria de leitura;
- reativar uma sessão de agente pausada ao clicar em “Liberar IA”;
- alterar prompt, JEV, ações do agente ou envio de mensagens.

## Casos de aceitação

1. Uma conversa com handoff pendente e ainda não aberta continua com o card vermelho e mostra o alerta sobre o avatar.
2. Ao abrir essa conversa, o vermelho some de acordo com a regra já existente e o selo azul de humano aparece, sem alterar a altura do card.
3. Uma conversa humana sem handoff também mostra somente o selo azul.
4. Uma conversa com `agent_allowed`, sessão `active` e agente ativo mostra somente o robô roxo.
5. Uma conversa sem agente ativo, mesmo que a IA esteja liberada, não mostra robô.
6. Horário, contador de mensagens não lidas, origem do canal, fila/responsável e prévia continuam visíveis e sem quebra adicional de linha.
7. Leitores de tela anunciam o estado de controle junto com a abertura do card.

## Verificação planejada

- Teste unitário da função de mapeamento para os quatro estados, incluindo a prioridade do alerta vermelho sobre `human_controlled`.
- Teste de renderização da fila confirmando o rótulo acessível e a classe/variante correta do selo.
- Verificação manual em desktop e largura móvel: confirmar que o selo não encobre rosto de forma relevante, contador de não lidas ou horário e que não aumenta o card.
- Executar `pnpm --filter @prymeira-talk/web test`, `pnpm --filter @prymeira-talk/web typecheck` e `pnpm --filter @prymeira-talk/web build`.
