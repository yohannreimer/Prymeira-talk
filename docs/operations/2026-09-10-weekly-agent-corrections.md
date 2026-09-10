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

Publicada em 10/09/2026: `1fba830d215538cc18d780d8727ecca1532f9878`. GitHub Actions `34491898216` concluída com sucesso. No Portainer, alterado somente o campo de imagem do serviço API `wseof97wna8dqec8jape6nshz`; sem reimplantar o editor desatualizado da stack, sem migração e sem alterar imagem web, variáveis ou canais.

Nova tarefa `yn3bnkelt8c667rnjwzqmisgj`, estado running; container `23ae0fb9a5b693d6bb03d04c50e1e136d38ec06241dece44f050eb93a55a61c2`. `/api/health` e `/api/ready` retornaram 200 com `ok:true` após a troca. Houve 502 transitório durante substituição da tarefa; recuperado sem rollback. Bundle verificado por SHA-256 `db5bb6cf7d4f5b273941531703660e3540e4a28db6febb01bb14c7572b276d2d`.

Prompt salvo somente no agente inativo de teste: SHA-256 `4cab9f120b4280edd6758ccb998e12f9af55f086ef016e6ffd0154f1814cea3a`. Nove casos originais foram repetidos no bundle publicado com snapshot desse agente e responderam sem o desvio original; o caso sem demanda também foi exercitado na interface. A definição portátil foi atualizada para novas importações. Não houve atualização em massa dos agentes existentes.

Rodadas anteriores: primeira candidata 100 replays; segunda 30 execuções (10 casos × 3); refinamento final 12 execuções (4 casos × 3). O mínimo ainda falhou na segunda candidata; passou nas três repetições finais e na publicada. Contagens de execução não são taxa de aprovação global. As 29 pendências de mídia/contexto não foram convertidas em aprovação.

Evidências integrais privadas do container anterior preservadas no large object PostgreSQL OID 26829, hash verificado; detalhes de recuperação no README privado de acompanhamento. Uma tentativa de exportar arquivo ao diretório do servidor falhou por permissão e foi revertida; não houve mudança de privilégios. O backup usado é um objeto binário da aplicação, sem alterações de tabelas de negócio ou esquema. Não remover esse objeto nem os resultados durante limpeza automática.

Verificação final local: 767 testes API passaram, 10 testes PostgreSQL ignorados, typecheck e build passaram. O teste no celular e a ativação continuam sob controle do usuário. Manter aprovação do vendedor no primeiro piloto; a bateria não certifica atendimento autônomo nem precisão integral de anexos.
