# Junior: confirmação de opções e recuperação de anexos

Aplicar somente após publicar a API desta alteração. O campo legado `systemPrompt` não controla o motor de atendimento ativo.

Agente alvo: `13093fdb-909e-4c9a-8935-21c87ab94986`, workspace `42e336e1-4ba8-4299-ba6d-8e2a01eef6cb`. Preservar todo o restante de `behaviorConfig`, inclusive os canais existentes. Adicionar em `behaviorConfig.harness`:

```json
{
  "recuperacaoDeAnexos": "reler_e_repassar",
  "regrasDoAtendimento": [
    "Resolva respostas como 'os dois', 'ambos' e 'as duas opções' pelas alternativas da sua pergunta imediatamente anterior. Quando houver mais de uma referência possível, confirme a interpretação provável em uma pergunta curta, em vez de repetir a pergunta original. Se você perguntou se os perfis são U enrijecido ou U estrutural e o cliente pediu orçamento 'com os dois', pergunte: 'Quer cotar cada perfil nas duas opções: U enrijecido e U estrutural?'. Mantenha as medidas, quantidades e comprimentos já informados. Até o cliente confirmar, não registre o tipo como escolhido nem encerre a coleta. Se responder sim, considere as duas opções para cada perfil; se corrigir, use a correção. Se a referência não estiver clara no histórico, peça esclarecimento sem inventar opções."
  ]
}
```

Se já houver regras de atendimento, acrescentar a regra acima à lista, sem substituir as demais. Uma atualização operacional deve conferir o ID/workspace e comparar a configuração atual com a lida antes da escrita, para não sobrescrever mudanças concorrentes.

Com a política ativa, PDF e imagem têm até duas tentativas no runtime. Falha persistente usa o repasse interno existente, muda a conversa para controle humano e preserva os anexos originais, sem pedir reenvio ou outro formato. Resultados bem-sucedidos já preparados são reaproveitados; o cache canônico exige hash da mesma mensagem/tipo/URL. Os limites de processamento continuam valendo.

## Diagnóstico observado em produção, 28/10/2026

- Consulta somente leitura no workspace do Junior, mensagens recebidas desde 14/10: 146 anexos; 85 com leitura processada, 25 com resultado de falha e 36 sem resultado de leitura nesses campos. Isso não mede a taxa de erro do agente: inclui anexos sem execução e cache do assistente da caixa de entrada.
- Três PDFs com falha persistida `PDF_IMAGE_INSPECTION_FAILED` foram inspecionados novamente a partir das cópias duráveis. `pdfimages -list` terminou com código 0 e inventário válido; o único diagnóstico foi a coleção de caracteres `PDFAUTOCAD-Identity0`. A correção aceita somente esse diagnóstico conhecido e força leitura visual, sem confiar no texto nativo.
- Um desses PDFs renderizou uma página PNG no contêiner de produção, sem alterar mensagens ou sessões.
- Uma imagem com falha visual anterior foi consultada novamente com o provedor configurado no workspace: HTTP 200, término `stop`, conteúdo presente. Esse teste confirma a disponibilidade atual, não a exatidão de todas as leituras nem a causa das falhas antigas.
- A implementação anterior agrupava qualquer HTTP de erro em `VISION_EXTRACTION_FAILED`. A nova classificação separa saldo, limite de chamadas, autenticação, indisponibilidade e rejeição da requisição; não persiste a mensagem bruta do provedor.

## Validação e reversão

Regressões cobrem segunda tentativa bem-sucedida ou falha, arquivos no mesmo lote, imagens, handoff efetivo mesmo sem ação configurada, cache válido/obsoleto e isolamento por canal/configuração. Os testes de inspeção preservam a rejeição de outras mensagens de erro e imagens acima dos limites.

Para desativar a mudança de comportamento no Junior, remover somente a política `recuperacaoDeAnexos` e a regra de atendimento adicionadas por esta tarefa. Reverter o código da API é uma ação separada; manter a imagem anterior para isso. Nenhum histórico precisa ser apagado ou reprocessado automaticamente.
