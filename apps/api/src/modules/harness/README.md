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

O primeiro agente é o `comprador` (módulo de orçamentos).

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

Outras variáveis: `HARNESS_MODEL`, `HARNESS_MODE=tools|json`, `HARNESS_REASONING=none|low|medium|high`, `FORNECEDOR_MODEL`, `HARNESS_CENARIOS=id1,id2`.

Uma conversa real que deu errado vira cenário novo em `cenarios.ts`.
