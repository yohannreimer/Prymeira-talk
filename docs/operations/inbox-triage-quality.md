# Qualidade da triagem da caixa de entrada

O filtro **Responder** usa o histórico recente com papéis explícitos (Cliente, Empresa humano e Empresa IA) e espera dois minutos após a última mensagem recebida antes de classificar. A classificação não envia mensagens ao cliente. Conteúdo ilegível ou falha dos dois modelos vira **Revisar**.

## Avaliação inicial (25/09/2026)

Foram revisados manualmente 77 episódios reais de conversas sob controle humano, com até 20 mensagens anteriores por caso: 35 precisavam de ação da empresa, 30 não precisavam e 12 tinham conteúdo insuficiente. Os textos dos clientes e as etiquetas individuais ficaram somente em arquivos temporários fora do repositório.

| Modelo | Pendências perdidas | Alertas indevidos | Mediana | p95 |
| --- | ---: | ---: | ---: | ---: |
| JEV, critérios ajustados | 0 | 4 | 250 ms | 637 ms |
| GPT-6 Luna, mesmo histórico | 3 | 0 | 1.339 ms | 2.730 ms |

JEV é o padrão pela prioridade de não esconder uma ação pendente. Luna é acionada se JEV falhar. A amostra é limitada e as etiquetas são uma revisão manual, não verdade absoluta; os quatro alertas indevidos restantes incluíram conversa social, propaganda e respostas automáticas. A equipe pode remover uma indicação pelo botão **Não precisa responder**, com dez segundos para desfazer. Uma nova mensagem recebida invalida a dispensa anterior.

O avaliador `apps/api/scripts/evaluate-inbox-triage.ts` exige pelo menos 50 casos etiquetados e informa os IDs dos erros sem registrar o conteúdo das conversas. Refaça essa comparação com uma amostra recente antes de trocar o modelo padrão ou as instruções.
