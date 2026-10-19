# Contextual Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unificar a análise e geração dos follow-ups de atendimento, comercial e prospecção, preservando regras de cada agente, cadência, aprovação e garantias de entrega.

**Architecture:** Uma definição reutilizável de follow-up usa o núcleo do harness para analisar pendências, decidir a ação por código, escrever e revisar. Adaptadores de perfil montam contexto e regras; o ciclo existente mantém calendário, claims, aprovação, envio e próxima etapa. Adoção versionada por agente/canal mantém compatibilidade com itens antigos.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, Vitest, harness Luna/JEV, contratos compartilhados Zod e validação PostgreSQL/RabbitMQ já existente.

---

## Escopo, base e entrega

Spec: [follow-ups contextuais compartilhados](../specs/2026-10-19-contextual-followups-design.md). Base inspecionada e branch alvo: `1d7aa19ed9c4a48532937408b9ece782c53d5cd6`, `codex/audit-stabilization-20261015`. Antes de implementar, revalidar a ponta dessa branch e as instruções locais aplicáveis; não usar a branch padrão antiga do repositório.

Esta entrega é **somente plano**. Não executa os passos abaixo, altera configurações produtivas, gera rascunhos produtivos, envia WhatsApp, reserva agenda ou reprocessa filas. Os passos são sequenciais, com execução inline possível. Não é necessário paralelismo.

Não migrar os motores de resposta das Marias/João, alterar ingress/identidade, redesenhar a tela, recriar campanhas ou adicionar uma segunda fila. Se uma implementação precisar tocar a entrega canônica ou schema além das fronteiras abaixo, revisar a spec e a validação dessa ampliação antes de fazê-lo.

## Mapa de arquivos

| Unidade | Criar | Modificar/preservar |
|---|---|---|
| Contratos/flag | `packages/shared/src/contextual-followup.ts` e `.test.ts` | export em `packages/shared/src/index.ts`; validação do JSON de behavior onde já existir |
| Contexto/perfis | `apps/api/src/modules/followups/contextual-followup-context.ts`, `contextual-followup-profiles.ts` e respectivos `.test.ts` | consumir context builder, conhecimento aprovado e estado de reunião existentes |
| Análise e decisão | `apps/api/src/modules/harness/agentes/followup/{tipos,instrucoes,ferramentas,jogadas,index,producao}.ts`; testes `followup.test.ts` e `jogadas.test.ts` | reutilizar núcleo `harness/core`; não alterar a definição ao vivo de atendimento/comercial |
| Política de entrega | `apps/api/src/modules/followups/contextual-followup-policy.ts` e `.test.ts` | usar critérios existentes, sem criar transporte |
| Lifecycle | `apps/api/src/modules/agents/contextual-followup-runtime.ts` e `.test.ts` | router em `agents/agent-followup-runtime.ts`; candidato/completação em `followups/conversation-followups.service.ts`; wiring em `app.ts` |
| Entrega contextual (adendo auditado) | `followups/contextual-followup-delivery.ts` e testes PostgreSQL | `followups/conversation-followups.routes.ts`, `conversations/conversations.service.ts`, `messaging/outbound-fences.ts`, `channels/outbound-router.ts`, contrato interno de `evolution.client.ts`; sem schema/fila nova |
| Regressão | testes existentes de runtime, serviço, rotas, scheduler, calendário, prospecção e harness | nenhuma remoção de guards para fazer testes passarem |
| Replay/operação | `apps/api/scripts/replay-contextual-followups.ts`, `apps/api/scripts/fixtures/contextual-followups-synthetic.jsonl`, `docs/operations/contextual-followups.md` | reaproveitar convenções de replay/validação existentes |

Os caminhos completos da tabela são relativos à raiz do repositório. Nas tarefas, nomes abreviados de módulos herdam o diretório definido pela tabela; comandos marcados como executados em `apps/api` partem dessa pasta. A lista é o contrato de escopo; nenhuma mudança SQL é prevista.

## Task 1: Contrato, seleção versionada e fixtures de regressão

**Files:** contrato compartilhado e teste; `agents/agent-followup-runtime.test.ts`; nova fixture sintética. Dependência: nenhuma.

- [ ] Criar fixtures sintéticas com nomes fictícios e timestamps fixos para os casos da matriz abaixo. Não copiar telefones, IDs ou conversas de produção.
- [ ] Escrever testes de schema: opção ausente mantém legado; `enabled=false` não cria novas adesões; versão/perfil desconhecido e canais vazios falham; selecionar canal errado não adere. Perfil não é deduzido do nome do agente.
- [ ] Definir e exportar os contratos Zod e tipos correspondentes. Contrato mínimo das saídas e opção:

```ts
export type FollowupProfile = "attendance" | "commercial" | "prospecting";
export type ContextualFollowupConfig = {
  version: 1;
  enabled: boolean;
  profile: FollowupProfile;
  channels: string[];
};
export type ContextualFollowupDecision =
  | { type: "customer_message"; body: string; evidenceMessageIds: string[] }
  | { type: "seller_reminder"; summary: string; evidenceMessageIds: string[] }
  | { type: "skip"; reason: "closed" | "no_pending" | "non_customer" | "customer_timing" }
  | { type: "unavailable"; reason: "context_limit" | "invalid_evidence" | "analysis_failed" | "empty_message" | "review_failed" | "policy_changed" };
```

O schema de `body` e `summary` exige trim não vazio; o de IDs exige pelo menos uma evidência para mensagem/lembrete. Validar existência/autor/trecho das evidências no builder/ferramentas; schema estrutural sozinho não basta. Nenhum ramo retorna data de envio ou ação externa.

- [ ] Acrescentar teste de integração do runtime com configuração comercial opt-in e conversa sintética aguardando escolha de horário: legado não satisfaz o teste; motor novo deverá produzir `review` com rascunho e zero chamadas de transporte. Estender o `buildRuntime` local existente para injetar o futuro handler contextual, sem exportar helpers de teste para produção.
- [ ] Executar `pnpm --filter @prymeira-talk/shared test` e, em `apps/api`, `pnpm exec vitest run src/modules/agents/agent-followup-runtime.test.ts`. Registrar falhas relacionadas aos contratos/handler ainda ausentes. Após implementar o schema, os testes exclusivamente de schema devem passar; o de runtime permanece vermelho até Task 6.
- [ ] Commit: `test(followups): specify contextual contracts and commercial regression`.

## Task 2: Contexto e adaptadores de perfil

**Files:** `contextual-followup-context.ts`, `contextual-followup-profiles.ts` e testes. Dependência: Task 1.

- [ ] Testar isolamento por workspace/agente, preservação de regras no fim de um prompt com mais de 4.000 caracteres, inclusão da âncora, autor correto e fontes aprovadas. Conhecimento comportamental deve ficar separado de fatos comerciais. Evidência fora do orçamento resulta em `unavailable/context_limit`, sem recorte silencioso.
- [ ] Testar `commercial` com origem `site_form` comprovada por `automation_webhook` e com entrada direta sem formulário; os dois usam as próprias regras. Importar a interpretação de origem da automação, sem extrair pelo nome da Maria ou por uma palavra do cliente.
- [ ] Testar reunião já reservada, horário antigo somente no histórico, promessa de reserva sem confirmação e transcrição pendente. O follow-up não anuncia nova disponibilidade nem confirma reserva sem estado real da agenda. Informação insuficiente para uma retomada factual causa abstenção.
- [ ] Testar `prospecting` com reserva confirmada e geração/sessão corretas versus reserva ausente, substituída, encerrada, opt-out, emergência e tomada humana. Reutilizar `findProspectingReservation`/`autonomousAgentAllowed` e guards de recusa; não remover o bloqueio de outbound frio sem resposta anterior.
- [ ] Implementar builder que entrega regras completas, instrução configurada da etapa, mensagens normalizadas com IDs, evidências do domínio e tentativas enviadas. Usar `buildConversationContext`, com orçamento explícito e cobertura verificável. Nunca copiar `metadata.harness.ficha` entre perfis.
- [ ] Implementar os três adaptadores: attendance fornece regras/base técnica do agente; commercial fornece origem, identidade, oferta e estado de reunião; prospecting fornece objetivo autorizado e estado da campanha, sem poderes novos. O adapter não depende de catálogo ou empresa padrão da Villefer.
- [ ] Rodar, em `apps/api`: `pnpm exec vitest run src/modules/followups/contextual-followup-context.test.ts src/modules/followups/contextual-followup-profiles.test.ts`. Esperado: todos passam e nenhum mock de transporte/Calendar é chamado.
- [ ] Commit: `feat(followups): build isolated context for each agent profile`.

## Task 3: Analista comum e decisão determinística

**Files:** `harness/agentes/followup/{tipos,instrucoes,ferramentas,jogadas,index}.ts` e testes. Dependência: Task 2.

- [ ] Definir ficha versionada de follow-up com papel do contato, encerramento, restrição temporal, pendências com dono e evidências, e tentativas enviadas. Persistir no namespace `contextualFollowup`, sem copiar prompts ou raciocínio livre do modelo.
- [ ] Criar testes dos casos: escolher horário; dado técnico ausente; orçamento entregue aguardando avaliação; empresa deve mandar orçamento; responsável indicado; recusa; conversa pessoal; simples agradecimento após resolução; oferta fria sem resposta; mensagem que resolve pendência antiga; nova pendência após fechamento antigo.
- [ ] Extrair a mecânica do analista de atendimento para ferramentas genéricas de pendência no novo diretório. Ferramentas aceitam IDs/trechos e rejeitam provas inexistentes ou atribuídas ao autor errado. Manter decisão por código após leitura. Não copiar defaults de aço, especificações ou a regra comercial de um cliente.
- [ ] Implementar seletor de ação que prioriza a pendência mais recente e sua resolução, respeita pedido de data futura e consulta quantidade de envios do plano efetivo. Sem pendência válida, não produzir mensagem. O seletor não recebe um client de banco/transportes nem altera cadência.
- [ ] Testar quatro etapas: `sentAttempts=3` e `maxAttempts=4` ainda admite a quarta; `4/4` não admite a quinta. Análise, rascunho ou falha técnica não entram em `sentAttempts`. O teste deve falhar se o antigo `maxFollowups: 3` for reintroduzido.
- [ ] Rodar, em `apps/api`: `pnpm exec vitest run src/modules/harness/agentes/followup/jogadas.test.ts src/modules/harness/agentes/followup/followup.test.ts`. Esperado: casos de seleção passam com modelos roteirizados, sem chamadas reais ao provedor.
- [ ] Commit: `feat(followups): share evidence-based pending-item analysis`.

## Task 4: Escrita, revisão e política de aprovação

**Files:** `harness/agentes/followup/producao.ts`; `contextual-followup-policy.ts` e testes. Dependência: Task 3.

- [ ] Usar `runTurn` com analista, escritor e revisão do núcleo. Regras do perfil complementam a revisão comum. Revisão indisponível/bloqueada não retorna texto aprovado, e `reply: null` não vira rascunho comercial vazio. Se o cliente de revisão não estiver configurado, retornar `unavailable/review_failed`; não omitir o juiz e aceitar o resultado `sem_juiz`. Uma reescrita limitada pode usar o mecanismo existente do runner; nunca um loop aberto.
- [ ] Testar texto que inventa horário, confirmação de agenda, preço, desconto ou especificação; repetição de pergunta já respondida; regra de outro cliente; vazamento de instruções; mensagem sem evidência. Esses casos não chegam a `customer_message` aprovado.
- [ ] Implementar política conservadora de revisão com esta função pura, além dos critérios específicos já existentes de elegibilidade automática:

```ts
export function requiresHumanReview(input: {
  delivery: "review" | "automatic" | undefined;
  profileAllowsAutomatic: boolean;
  legacyKindAllowsAutomatic: boolean;
  reviewApproved: boolean;
  risk: "none" | "commercial" | "unclear";
}): boolean {
  return input.delivery !== "automatic"
    || !input.profileAllowsAutomatic
    || !input.legacyKindAllowsAutomatic
    || !input.reviewApproved
    || input.risk !== "none";
}
```

`profileAllowsAutomatic` é calculado por validação do domínio, não pelo modelo. Para prospecting, reserva válida continua necessária, mas nunca torna `delivery=review` automático. Para os demais, não ampliar os tipos que hoje podem enviar automaticamente.

- [ ] Teste de barreira, usando a função acima no teste unitário:

```ts
it.each(["attendance", "commercial", "prospecting"] as const)(
  "%s cannot bypass channel review", () => {
    expect(requiresHumanReview({
      delivery: "review", profileAllowsAutomatic: true,
      legacyKindAllowsAutomatic: true, reviewApproved: true, risk: "none"
    })).toBe(true);
  }
);
```

- [ ] Rodar, em `apps/api`: `pnpm exec vitest run src/modules/followups/contextual-followup-policy.test.ts src/modules/harness/agentes/followup/followup.test.ts`. Esperado: todos passam, sem executar ações retornadas pelo modelo.
- [ ] Commit: `feat(followups): enforce reviewed drafts across all profiles`.

## Task 5: Candidatos, calendário e identidade da sequência

**Files:** `followups/conversation-followups.service.ts`, `followups/channel-followup-plan.ts` e respectivos testes; contrato compartilhado. Dependências: Tasks 1–4.

- [ ] Introduzir um resolvedor puro de motor utilizado por serviço e runtime. Nova adesão exige flag habilitada, canal autorizado, perfil validado e autoridade do domínio. Registro com marcador contextual usa o handler da sua versão mesmo se a flag for desligada; versão desconhecida fica contida e nunca cai no legado.
- [ ] Na criação do candidato opt-in, aplicar guards determinísticos de escopo, estado e envolvimento anterior comprovado. Uma submissão real do formulário registrada pela automação é evidência para o site mesmo antes de uma resposta no WhatsApp; não é exceção para abordagem fria. Adiar a análise semântica para o vencimento. Não chamar a seleção técnica legada nem usar `promisesSellerAction` como descarte: a promessa da empresa pode gerar lembrete interno. Preservar a seleção legada para registros não aderidos. Âncora de PDF/texto consecutivos e nova mensagem mantêm o comportamento canônico atual.
- [ ] Persistir marcador `decision.contextualEngine` e hash de política; preservá-los em `evaluateCandidate`, próxima etapa manual/automática e recuperações. Marcador não substitui `kind`, claim ou chave ativa. A origem de um agente não confere autorização automática.
- [ ] Testar calendário com relógio fixo em `2026-10-19T15:38:00.000Z`: plano Prymeira `[120,1440,2880,5760]`, dias úteis `1..5`, `09:00–18:00`, `America/Sao_Paulo`. Primeiro vencimento é `2026-10-19T17:38:00.000Z`. A etapa seguinte parte do envio efetivo; intervalo que cair no sábado avança para segunda-feira às 09h. Plano cumulativo antigo continua aplicando diferenças entre marcos, sem virar intervalos completos.
- [ ] Testar que draft, edição, adiamento, análise ou falha não criam etapa seguinte; envio manual/automático confirmado a cria uma única vez; quatro etapas não viram três; `scheduledAt`, âncora e contadores existentes não mudam por ligar/desligar flag. Mudança de descrição/ID da pendência não zera o contador da sequência.
- [ ] Testar espera específica pedida pelo cliente: ao chegar a cadência antes desse prazo, bloquear mensagem e apresentar motivo. Não interpretar `timingNote` do modelo como comando de reagendamento.
- [ ] Rodar, em `apps/api`: `pnpm exec vitest run src/modules/followups/channel-followup-plan.test.ts src/modules/followups/conversation-followups.service.test.ts src/modules/followups/conversation-followup-scheduler.test.ts`. Esperado: testes novos e antigos passam com relógios/fixtures isolados.
- [ ] Commit: `feat(followups): preserve cadence through contextual sequence lifecycle`.

## Task 6: Integrar o runtime sem novos poderes de envio

**Files:** `agents/contextual-followup-runtime.ts`, `agents/agent-followup-runtime.ts`, `app.ts` e testes. Dependência: Task 5.

**Adendo de escopo necessário, auditado em 19/10/2026:** incluir os arquivos de entrega da tabela e testes PostgreSQL da fronteira/adaptador. O adendo técnico da spec define a origem `followup` sem wrapper de prospecção aninhado, revisão transacional de política e fontes, congelamento da aprovação, discriminação de entrega contextual sem fallback direto, reserva pré-transporte e correção de timestamps de âncora. A base exige esses hooks para satisfazer as invariantes já aprovadas; não há mudança SQL nem redesenho de ingress/router.

- [ ] Injetar um handler contextual no factory existente. Depois de claim e revalidação, selecionar o handler pelo marcador da sequência; só os itens antigos seguem para `runHarnessFollowup`, `runBrainFollowup` ou legado. A flag de adoção não é reinterpretada no meio de uma sequência.
- [ ] O handler carrega contexto/perfil, roda análise/escrita/revisão e revalida âncora, sessão, geração e hash de política antes de persistir a saída. Falha de claim/revalidação não chama modelo nem transporte. Persistência usa a mesma condição de posse de claim; eventos saem de registros persistidos.
- [ ] Mapear saídas: customer_message → review ou elegibilidade automática existente; seller_reminder → tipo existente sem texto ao cliente; skip → estado terminal com razão; unavailable → recuperação técnica limitada ou falha identificada. Não salvar `customer_message` sem body válido.
- [ ] Reutilizar o caminho canônico de entrega; manter revalidação final e completadores manual/automático. A restrição `review` é conferida novamente antes de qualquer transporte, inclusive quando existe reserva de prospecção. Não mudar o caminho ao vivo de `agent-runtime.ts` nem o agendador de reuniões.
- [ ] Executar o teste da Task 1: deve ficar verde com `review`, rascunho sobre a escolha de horário e zero envio. Estender a fixture para Maria dos anúncios (`harness.agente=comercial`) e João com reserva válida: ambos usam o handler contextual quando aderidos, sem mudar seus motores ao vivo.
- [ ] Cobrir concorrência: cliente responde durante análise; humano assume; regra editada; geração muda; reset; duas instâncias; aprovação com `expectedUpdatedAt` antigo; sucesso de provedor seguido de falha de conclusão. Nenhum caso reenvia uma operação incerta ou cria duplicata.
- [ ] Rodar, em `apps/api`: `pnpm exec vitest run src/modules/agents/contextual-followup-runtime.test.ts src/modules/agents/agent-followup-runtime.test.ts src/modules/followups/conversation-followups.routes.test.ts src/app.followup-lifecycle.test.ts`; depois `pnpm --filter @prymeira-talk/api typecheck` na raiz. Esperado: todos passam; nenhum endpoint exige mudança incompatível.
- [ ] Commit: `feat(followups): route profiles through contextual generation`.

## Task 7: Replay, revisão comparativa e validação da release

**Files:** script/fixtures/revisão operacional da tabela. Dependência: Task 6.

- [ ] Implementar replay que importa apenas componentes de análise/escrita/revisão, recebe fixtures sintéticas e não importa Prisma, scheduler, transporte, filas nem Calendar. Adaptadores de efeitos devem lançar erro se chamados. Comparar baseline e contextual sobre a mesma fixture, conservando todos os resultados e razões de bloqueio.
- [ ] Relatório por cenário: perfil, motor/versão, hashes das regras/fontes, ação, rascunho, evidências, revisão e duração. Não exportar prompt completo, conversas produtivas ou raciocínio interno. Conservar falhas, sem escolher só rodadas favoráveis.
- [ ] Acrescentar script de execução `harness:replay-contextual-followups` em `apps/api/package.json`: `tsx scripts/replay-contextual-followups.ts`. Sem token de modelo, usar modelo roteirizado; execução com modelo real é uma rodada separada explicitamente autorizada e com limite de chamadas.
- [ ] Rodar na raiz: `pnpm --filter @prymeira-talk/api harness:replay-contextual-followups`. Esperado: todos os cenários sintéticos abaixo respeitam ação/autoridade; qualquer divergência retorna exit não zero e mantém resultado para revisão.
- [ ] Revisar manualmente os textos e a diferença baseline/contextual. Qualidade exige evidência por cenário, sem aceitar somente contagem verde ou nota média. Obter aprovação da comparação de Villefer antes de habilitar seus canais.
- [ ] Rodar `node apps/api/scripts/validation/run.mjs` somente com PostgreSQL descartável e vhost RabbitMQ próprios, conforme `docs/operations/release-validation.md`. Isso exige implementação e ambiente preparados; não é validação executada por esta PR de documentação. Guardar resultado do SHA exato. CI de PR valida sem publicar imagens; merge/deploy ficam separados.
- [ ] Commit: `test(followups): qualify contextual profiles and rollout evidence`.

## Matriz mínima do replay e das integrações

| Caso sintético | Resultado exigido |
|---|---|
| Comercial/site recebeu formulário real e ofereceu horários | Retomar escolha sem reapresentação, sem presumir preço/proposta |
| Formulário comprovado, sem primeira resposta no WhatsApp | Candidato preserva envolvimento do site; texto sem formulário real não cria a exceção |
| Comercial/anúncio sem formulário | Não mencionar formulário recebido; mesma análise de pendência |
| Horário aceito, reserva ainda sem confirmação | Não afirmar reunião marcada; não executar Calendar no follow-up |
| Reunião já confirmada | Não convidar a reservar outra; preservar próximo passo real |
| Cliente pediu contato somente após data futura | Nenhuma mensagem antes da restrição; motivo visível |
| Cliente precisa responder sobre catálogo pedido e entregue | Pergunta contextual de avaliação, sem inventar cotação |
| Cliente já informou medida/quantidade | Não perguntar de novo; preservar correção mais recente |
| Empresa deve preparar orçamento | Lembrete interno, zero mensagem ao cliente |
| Oferta fria nunca respondida | Sem sequência nova de outreach |
| Prospect indicou comprador | Lembrete interno, sem novo destinatário automático |
| Recusa/opt-out/controle humano/reset/geração antiga | Nenhum envio, rascunho obsoleto invalidado |
| Texto de cliente manda mudar perfil ou ignorar revisão | Instrução ignorada; não amplia poderes |
| Fonte comportamental contém promessa comercial | Não tratar como prova de condição |
| Review + perfil prospecting + reserva confirmada | Rascunho, zero chamada de transporte |
| Três envios de um plano de quatro etapas | Quarta permitida pelo plano, quinta bloqueada |
| Duplo claim/aprovação obsoleta/entrega incerta | Sem duplicata e sem reenvio automático |
| Contexto/revisor/provedor indisponível ou resposta vazia | Abstenção/falha identificada; nenhum draft comercial vazio |
| Casos já validados do atendimento Villefer | Preservar pendência, dono, recusas e resultado de revisão |

## Task 8: Adoção operacional separada da implementação

**File:** `docs/operations/contextual-followups.md`. Dependência: release qualificada e autorização específica de ativação.

- [ ] Preparar manifesto de adoção: agente/canal/perfil, revisão do código, hashes de políticas, cadência e modo de aprovação antes/depois. Campos estranhos à opção aditiva devem permanecer idênticos. Não enviar dados reais para outro serviço para fazer sombra.
- [ ] Rodar sombra dos três perfis sobre fixtures aprovadas; custo/modelo real e inspeção produtiva só no escopo autorizado. Corrigir divergências antes de pedir ativação.
- [ ] Propor piloto das Marias apenas para novas sequências do canal Prymeira, mantendo `review`, quatro intervalos e 09h–18h. Não trocar a automação do site nem `behaviorConfig.harness`. João entra após validar reserva/geração e começa por rascunhos; Villefer entra por canal após comparação aprovada.
- [ ] Mostrar inventário somente leitura de itens antigos ainda ativos. Manter motor/horário/estado originais. Eventual reparação de review sem texto é uma ação separada: mesmos IDs e cadência, CAS por `updatedAt`, nenhuma mensagem nova desde a âncora, nenhuma evidência de envio incerto, sem reabrir cancelados/sent e sem disparo real.
- [ ] Validar rollback com fixture: desligar novas adesões não envia/recria nada; registros contextuais existentes continuam reconhecidos pela release compatível ou ficam contidos. Não voltar para imagem sem handler versionado enquanto houver esses itens ativos.
- [ ] Retirar o legado apenas em PR posterior após inventário confirmar zero dependências ativas, regressões/replay aprovados e janela de observação acordada. Não inferir sucesso só pela ausência de erro nos logs.

## Checklist de revisão desta implementação futura

- [ ] Cada invariante da spec está ligado a teste ou procedimento desta lista.
- [ ] Aprovação do canal é mais restritiva que qualquer permissão de campanha.
- [ ] Perfil, fontes e regras não dependem de nome de agente/empresa hardcoded.
- [ ] Sem corte silencioso de regras; sem número fixo de três no contextual.
- [ ] Candidatura e execução usam a mesma seleção versionada.
- [ ] Completadores preservam marcador e contam somente envios confirmados.
- [ ] Incerteza de entrega nunca leva a replay; rollout não recalcula itens antigos.
- [ ] Sem migração do atendimento ao vivo, alteração de schema ou ativação implícita.
- [ ] Resultados de testes/replay e estado produtivo são declarados separadamente.

## Validação desta PR de plano

Conferir links e caminhos existentes, os nomes dos novos arquivos e as assinaturas utilizadas nos exemplos; executar `git diff --check` limitado aos dois documentos. Conferir que o diff contém somente a spec e este plano, sem arquivos de runtime/configuração produtiva. Testes de implementação acima permanecem não executados até existir implementação. A PR de documentação pode disparar o gate normal do repositório; seu resultado não comprova a implementação futura nem uma migração em produção.
