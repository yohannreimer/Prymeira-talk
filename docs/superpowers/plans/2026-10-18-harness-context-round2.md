# Atendimento: revisão com contexto — plano e desenho

Execução nesta sessão, sem subagentes, autorizada pelo pedido de corrigir os erros observados e repetir os 15 cenários. Mantém o desenho aprovado: evidência específica/complementar, resposta antes de ofertas e revisão antes de tratar a pergunta.

**Objetivo:** eliminar falsos bloqueios por similaridade lexical e antirrepetição sem liberar mensagens sem base.

**Arquitetura:** similaridade de palavras orienta uma releitura, mas não prova insuficiência da evidência. A revisão semântica final continua verificando cada pergunta e afirmação contra as fontes completas. Repetição factual passa a ser julgada no contexto: responder uma pergunta renovada ou retomar um dado ainda ausente é permitido; repetir ofertas permanece vedado. Instruções de leitura/escrita e revisão devem distinguir família de produto de liga/medida confirmada e cobertura de cidade de prazo/frete.

**Alternativas avaliadas:** adicionar exceções por produto/cidade perpetuaria a heurística frágil; retirar toda revisão perderia proteção. A opção escolhida preserva as regras objetivas e a revisão por requisito, retirando somente o veto lexical descontextualizado.

**Tecnologias:** TypeScript, Vitest, harness Luna e JEV existentes.

- [x] Reproduzir falsos bloqueios com fichas reais sintéticas da primeira rodada e conflitos de repetição; executar testes antes da correção.
- [x] Remover veto lexical final (manter dica de releitura); levar repetição factual ao juiz com exceção explícita para pergunta renovada/dado pendente. Preservar bloqueio de repetição da oferta de catálogo/vendedor. Alinhar instruções de leitura, escrita e juiz sobre cidades atendidas, inox/ligas e mínimo aproximado, sem codificar política da Villefer fora da base.
- [x] Executar testes de regressão, suíte do harness, typecheck e build. Repetir exatamente os 15 cenários/18 turnos com modelo real e snapshot da base, sem executar ações. Gerar comparação preservando todos os resultados, inclusive falhas.

Não há deploy, escrita no banco, mensagem WhatsApp ou alteração na base nesta tarefa. Testes sintéticos com rejeição do juiz devem continuar sem tratar perguntas rejeitadas; indisponibilidade do juiz continua fechada.

## Resultado observado

- Regressões iniciais: 8 testes falharam antes da correção; depois passaram. Os testes adicionais de catálogo e fontes do redator também falharam antes do ajuste.
- API final: 2.915 testes aprovados, 798 ignorados; tipos e build aprovados. Harness: 122 testes aprovados.
- Mesmos 15 cenários/18 turnos, modelo real e hash da base idêntico: primeira rodada 7 bloqueios finais; segunda 2; validação adicional 0, com 2 reescritas e 1 repasse específico por peso da variante W150.
- Código candidato validado: 8a62fa0a8a36d39d3314e55832498e574e0c9caf. Não publicado em produção; nenhuma mensagem, cotação ou gravação no banco executada.
- Relatórios HTML das rodadas preservados fora do repositório, na pasta outputs da tarefa. Respostas úteis incluem ressalvas de redação; as rodadas não estimam uma taxa geral de acerto.
