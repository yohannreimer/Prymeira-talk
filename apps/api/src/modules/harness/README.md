# Harness dos agentes

Motor novo e compartilhado dos agentes do Talk. Ainda **não está ligado em nenhuma conversa real**: hoje ele roda só no simulador.

## Como uma mensagem passa pelo harness

```
mensagem do contato
 1. triagem      regras (robô, recusa, injeção, despedida) + JEV opcional      core/triage.ts
 2. leitura      o modelo registra na ficha o que a mensagem informa,           core/runner.ts
                 usando as ferramentas de leitura do agente
 3. jogada       o CÓDIGO do agente decide o próximo passo pela ficha           agentes/<agente>/jogadas.ts
 4. escrita      o modelo escreve a mensagem dessa jogada (ferramenta responder) core/runner.ts
 5. revisão      regras duras em código + juiz (JEV) opcional;                  core/review.ts
                 bloqueou → reescreve uma vez → bloqueou de novo → humano
 6. envio        devolve o texto aprovado, a ficha nova e o rastro de cada passo
```

O modelo nunca decide o processo (quando pedir desconto, quando revelar um número, quando parar). Ele lê e escreve.

No **silêncio** (conversa parada), se o agente tem um `analista`, um subagente roda antes da jogada: lê a conversa inteira numerada, com mais raciocínio, e atualiza a ficha com as ferramentas dele. Ele só lê; não escreve nada para o contato. Cada registro cita o número da mensagem e um trecho exato, e o código confere que o trecho está lá. O que não tem prova não entra na ficha.

Duas travas valem para todos os agentes:
- **Sem "vou consultar e já te aviso".** A regra `sem_promessa_de_retorno` bloqueia a mensagem que promete consultar e retornar depois. O escritor responde com o que tem ou pergunta o que falta. Só a jogada que realmente leva algo para a empresa decidir libera isso (`dados.podePrometerRetorno`).
- **Passar para humano tem motivo fechado.** Cada agente lista em `motivosParaHumano` quando pode passar a conversa para uma pessoa. Fora da lista, o pedido é recusado uma vez e o escritor tem de responder.

## O que é de cada agente

Um agente novo é uma pasta em `agentes/` que preenche `AgentDefinition` (`core/types.ts`):

| Arquivo | O que tem |
|---|---|
| `instrucoes.ts` | Quem é, tom, o que nunca faz, e as skills (procedimentos que só entram quando a jogada pede) |
| `tipos.ts`, `ficha.ts` | A ficha (memória da conversa como dado) e como ela aparece para o modelo |
| `ferramentas.ts` | Ferramentas de leitura: como o modelo grava o que aprendeu na ficha |
| `jogadas.ts` | O processo em código: qual é a próxima jogada |
| `regras.ts` | Regras duras do revisor |
| `cenarios.ts` | Cenários do simulador e o que conferir no fim de cada um |

Agentes:
- `comprador`: módulo de orçamentos.
- `atendimento`: respostas ao vivo e follow-up. Ainda roda só no simulador; o atendimento real continua no motor atual.
  - **Ao vivo**, o leitor registra cada pergunta e procura nos documentos (`buscar_na_base`). Ela só conta como respondida com a citação exata de um trecho, e só pode ser marcada "sem base" depois de procurar. O código responde o que tem trecho e passa para o vendedor só o que a base não cobre, com uma frase sobre aquele assunto (jogada `responder_e_passar`).
  - **No silêncio**, o analista confere a ficha e o código decide entre cobrar o cliente, lembrar o vendedor ou ficar quieto.

## Simulador

Cada cenário é uma conversa inteira contra um fornecedor de roteiro ou um fornecedor interpretado por uma IA. No fim, o código confere o estado final (a proposta na ficha bate? vazou nome de concorrente? fez a choradinha?). Cada cenário roda `k` vezes e só conta se passar **todas** (pass^k).

```bash
# sem modelo (modelos falsos determinísticos; é o que roda no CI)
HARNESS_OFFLINE=1 pnpm --filter @prymeira-talk/api harness:simular

# com a Luna do workspace (lê o provedor de IA do banco; nada é enviado no WhatsApp)
HARNESS_WORKSPACE_ID=<id> pnpm --filter @prymeira-talk/api harness:simular

# com JEV na triagem e no revisor, 4 tentativas, relatório em arquivo
HARNESS_WORKSPACE_ID=<id> JEV_API_KEY=... HARNESS_K=4 HARNESS_RELATORIO=relatorio.md pnpm --filter @prymeira-talk/api harness:simular

# a Luna aceita ferramenta nativa? (testa modo tools e json, com e sem raciocínio)
HARNESS_WORKSPACE_ID=<id> pnpm --filter @prymeira-talk/api harness:sondar-modelo
```

```bash
# follow-up do atendimento (precisa de modelo); HARNESS_CASOS junta conversas reais rotuladas
HARNESS_AGENTE=atendimento HARNESS_WORKSPACE_ID=<id> JEV_API_KEY=... pnpm --filter @prymeira-talk/api harness:simular
HARNESS_AGENTE=atendimento HARNESS_WORKSPACE_ID=<id> HARNESS_CASOS=casos.jsonl pnpm --filter @prymeira-talk/api harness:simular
```

`HARNESS_CASOS` usa o mesmo formato do `eval:followup-brain` (uma linha JSON por conversa: `caseId`, `expected`, `messages`), então as mesmas conversas medem o motor velho e o novo.

Outras variáveis: `HARNESS_REASONING_ANALISTA` (padrão `high`), `HARNESS_MODEL`, `HARNESS_MODE=tools|json`, `HARNESS_REASONING=none|low|medium|high`, `FORNECEDOR_MODEL`, `HARNESS_CENARIOS=id1,id2`.

Uma conversa real que deu errado vira cenário novo em `cenarios.ts`.
