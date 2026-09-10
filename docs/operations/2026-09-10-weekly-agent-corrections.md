# Correções da bateria real — 10/09/2026

Escopo solicitado: corrigir os desvios encontrados nas conversas reais, preservando o agente ativo, canais e envio humano. Execução nesta tarefa, sem delegação. Não ampliar catálogo nem converter restrições históricas de vendedores em regras gerais.

## Diagnóstico e decisão

- C019-T02: `isDocumentDependentQuestion` considerava qualquer `?`, inclusive em “tudo certo?”, junto à categoria “aços” na frase seguinte. A regra de falta de documento interceptava a resposta antes do modelo. Reproduzido em quatro testes que falharam antes da correção. A alteração remove somente perguntas sociais exatas antes de avaliar dependência de fonte; perguntas como “Tudo certo com a entrega?” continuam protegidas.
- C033-T09/C083-T03: catálogo genérico recuperado conflitava com uma recusa específica do vendedor. O prompt agora distingue categoria oferecida de restrição da negociação atual.
- C012-T02/C033-T11/C054-T03: saudações e confirmações após atuação do vendedor disparavam nova qualificação. Prioridade explícita para continuidade, sem reiniciar checklist/repasse.
- C081-T03: pedido de exceção ao mínimo precisa de confirmação, sem reiniciar a qualificação como se a restrição não existisse.
- C075-T05: leitura visual não autoriza promessa de adequação técnica. C066-T01: abreviação clara de quantidade não deve gerar confirmação redundante; preservar a grafia original na nota.

Escolha: correção mínima no classificador compartilhado + regras de continuidade no modelo portátil Villefer. Apenas acrescentar instruções ao prompt não resolveria C019 porque a resposta era interceptada antes do provedor. Não foi criada lista global de produtos recusados por vendedores históricos.

## Verificação

- Primeiro ciclo: 4 falhas novas reproduzidas; após correção, 38 testes dos dois arquivos passaram.
- API completa após a primeira revisão do prompt: 767 passaram, 10 PostgreSQL ignorados por ausência de banco de teste; typecheck e build passaram. Não confundir testes unitários com aprovação das respostas reais.
- Replays reais: versão candidata em processo isolado, sem bootstrap do servidor, envio ou executor de ações. Mesmas mensagens/extrações da bateria anterior, sem incluir respostas futuras. Arquivos privados permanecem no container; registrar conclusão e publicação abaixo apenas após verificação.

## Arquivos

- `knowledge-retrieval.ts` e testes: regra compartilhada de perguntas sociais.
- `agent-test-chat.test.ts`: regressão C019, com provedor chamado e sem handoff.
- `villefer-v1-definition.ts` e testes: prompt portátil, sem dados de clientes ou números específicos de vendedores.

## Publicação

Ainda não publicada no momento deste registro. O teste no celular e a ativação do canal continuam sob controle do usuário. Não usar o editor antigo da stack; quando houver publicação, trocar somente a imagem do serviço API após confirmar a tag e preservar as demais configurações.
