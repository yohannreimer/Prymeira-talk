# Atendimento natural: implementação

**Goal:** executar o comportamento aprovado no desenho desta data e validar os 68 pontos reais antes da publicação.

**Architecture:** triagem semântica de saudação separada de despedida; jogadas explícitas de acolhimento e recusa; leitor/redator/juiz alinhados sobre intenção e pendências internas. Execução direta nesta sessão, conforme pedido do usuário.

**Tech Stack:** TypeScript, Vitest, harness de atendimento, Luna JSON e JEV existentes.

- [x] Criar `apps/api/src/modules/harness/natural-attendance.test.ts` reproduzindo saudações tratadas como despedida, acolhimento vazio e recusas cobrando cadastro; executar `pnpm --filter @prymeira-talk/api exec vitest run src/modules/harness/natural-attendance.test.ts` e observar falhas anteriores à correção.
- [x] Em `core/triage.ts`, separar saudações puras de cortesias finais. Em `agentes/atendimento/jogadas.ts`, priorizar acolhimento e recusa integral, preservar pedidos de pessoa e marcar `qualificarPedido` explicitamente para respostas comuns.
- [x] Em `agentes/atendimento/instrucoes.ts` e `index.ts`, orientar abertura ativa, evitar agradecimento genérico e reconhecer listas sem narrar pendências internas. Em `regras.ts`, conferir abertura e agradecimento genérico. Em `juiz.ts`, validar ressalva não perguntada e ativar coleta pelo dado estruturado, mantendo verificação de fatos e perguntas diretas.
- [x] Ajustar fixtures do revisor para o contrato estruturado; executar regressões novas, todos os testes do harness, typecheck e build de produção.
- [x] Criar runner temporário fora do Git com as 68 respostas históricas e fontes exportadas. Empacotar candidato, rodar no ambiente de teste isolado com provedores reais e sem ações de envio/escrita; preservar saídas, falhas e hash de entradas.
- [ ] Rever cada geração; corrigir falhas observadas e repetir todos os casos se houver mudança de comportamento. Preparar relatório comparativo revisável em outputs, sem dados de clientes em commits.
- [ ] Publicar commit/imagem com CI aprovado, conferir versão ativa e preservar mudanças concorrentes; verificar saúde e versão após implantação, sem mensagens artificiais para clientes.

## Ajustes encontrados nas simulações

- Preservar `natureza` e palavras do pedido no leitor; perguntas factuais continuam revisadas mesmo se a classificação estiver errada.
- Uma citação negativa complementar não torna um pedido misto integralmente recusado. Não exigir dados de cotação quando a ficha não tem qualificação restante.
- Repetição e ressalva usam somente mensagens reais e a candidata, em uma revisão sem citações/instruções internas. Fatos, condições e produto continuam em revisão separada com fontes completas.
- Não analisar como condição comercial uma pergunta que não afirma condição; não analisar como incerteza uma simples negativa de fornecimento ou repasse do orçamento.
- Mídia `video/*` não analisável pede foto/descrição, preservando limites e segurança do processamento.
- Regressões focadas finais: 334 aprovadas. Suítes CI anteriores passaram; a revisão final dos 68 pontos e o CI da revisão que será publicada continuam pendentes nesta etapa.
