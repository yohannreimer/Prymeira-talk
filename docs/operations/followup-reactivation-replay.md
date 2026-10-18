# Replay do motor de reativação

O harness mantém uma venda aberta após silêncio, recebimento de catálogo ou avaliação do orçamento. A condição informada pelo vendedor nesta negociação prevalece sobre a regra geral da base. Pedido completo sem cotação respondida gera lembrete interno; qualificação incompleta permite perguntar o dado essencial. O revisor aponta uma falha concreta, sem usar uma nota genérica de conveniência para vetar a retomada.

Cadência, limite de tentativas, janela comercial e modo de revisão continuam na configuração do canal. O contexto do follow-up passa a incluir até 200 mensagens; o atendimento ao vivo mantém sua janela anterior. Conversas maiores continuam limitadas: não se afirma que todo o histórico foi lido.

## Teste com modelos reais, sem envio

Na pasta `apps/api`, execute `pnpm harness:replay-followups` com:

- `FOLLOWUP_REPLAY_FILE`: caminho de JSON local com `config`, `sources` e `cases`.
- `OPENAI_API_KEY` e `JEV_API_KEY`: credenciais já autorizadas dos provedores, fornecidas pelo ambiente, sem salvá-las no arquivo.
- Opcionais: `OPENAI_BASE_URL`, `FOLLOWUP_REPLAY_MODEL`, `JEV_MODEL`, `FOLLOWUP_REPLAY_NOW` e `FOLLOWUP_REPLAY_OUTPUT`.

Essas opções são do teste local; não são novas variáveis necessárias ao deploy.

Exemplo de arquivo de entrada, com conversa sintética:

```json
{
  "config": {"agente":"atendimento","canais":["replay"],"empresa":{"nome":"Empresa","oQueVende":"Aço"}},
  "sources": [],
  "cases": [{
    "id":"barra-sem-resposta",
    "expected":["mensagem"],
    "messages":[
      {"id":"1","autor":"contato","texto":"Preciso de dez barras chatas de 6 metros.","em":"2026-10-13T12:00:00Z"},
      {"id":"2","autor":"humano","texto":"Segue o orçamento das dez barras.","tipo":"file","em":"2026-10-13T12:01:00Z"},
      {"id":"3","autor":"contato","texto":"Obrigado, vou avaliar.","em":"2026-10-13T12:02:00Z"}
    ]
  }]
}
```

O replay importa apenas o harness e os clientes de modelo. Não tem cliente de banco, fila ou transporte WhatsApp. O resultado contém ficha, ação, texto, revisões e etapas. O campo `matchedExpectedAction` verifica a ação esperada; ele não substitui a leitura humana da mensagem. O processo retorna erro se houver ação divergente ou falha na geração. Arquivos com conversas reais e credenciais nunca entram no Git.
