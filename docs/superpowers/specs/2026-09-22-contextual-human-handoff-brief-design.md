# Apoio contextual para repasses humanos

## Problema e objetivo

O cartão “Humano necessário” da IA de apoio hoje concatena as três últimas mensagens recebidas e escolhe um “Faça agora” fixo a partir de um motivo amplo. Ele repete a conversa em vez de dizer ao vendedor por que o agente parou e qual trabalho precisa ser feito. Por exemplo, `commercial_policy_risk` não explica sozinho que o pedido de Ricardo envolve um material cuja viabilidade não foi confirmada.

O objetivo é entregar ao vendedor, sem exigir que ele releia a conversa, **uma próxima ação curta e executável** e **um resumo suficiente para executá-la**. O apoio é interno: não envia mensagem, não libera a IA e não decide disponibilidade, preço ou condições comerciais.

## Experiência aprovada

O cartão mantém o estado “Humano necessário” e exibe somente dois blocos principais:

1. **Faça agora:** uma instrução curta no imperativo, específica para a pendência que motivou o repasse. Não ensinar o vendedor a vender nem repetir “confirme o pedido” por padrão.
2. **Resumo:** fatos úteis para aquela ação, incluindo itens, especificações, quantidades, identificação e logística quando informadas; acrescentar apenas compromissos anteriores e pendências que mudem a ação. Corrigir dados substituídos por mensagens mais recentes. Não concatenar mensagens literalmente.

Exemplo de material incerto: “Verifique se trabalhamos com o material solicitado.” Resumo: “Ricardo, da Fetti Fundição ou ZK Máquinas, pediu cotação de quatro peças em aço 1045 para porcas, diâmetros externo 220 mm e interno 125 mm, comprimento 160 mm; mencionou oxicorte. Foi prometido um retorno. Viabilidade e preço não foram confirmados.” Se o pedido estiver qualificado e o repasse for para proposta, a ação é “Prepare a proposta comercial”, com todos os dados necessários à proposta no resumo. Se faltar dado indispensável, a ação deve ser obter esse dado, não preparar uma proposta incompleta.

O texto se atualiza automaticamente quando novas mensagens do cliente ou da equipe mudam a situação. Mensagens consecutivas podem ser agrupadas para evitar geração repetida. O vendedor vê “Atualizando” enquanto a versão nova é preparada; uma versão antiga não pode se apresentar como atual.

## Origem da decisão e geração

No handoff, preservar junto da sessão a origem e o motivo real disponíveis: solicitação do agente, auditoria JEV, política de segurança, baixa confiança ou pedido humano; associar o último run e mensagem que dispararam a decisão. Um código genérico do JEV, como `commercial_policy_risk`, não prova sozinho qual produto foi considerado duvidoso. A IA de apoio usa esse registro, o histórico relevante e o conhecimento aprovado do agente para formular a ação e o resumo, distinguindo fato registrado de inferência sobre o contexto.

Uma geração interna e assíncrona produz um objeto estruturado com `nextAction`, `summary`, referência às mensagens e ao motivo usados, além da versão do último evento relevante. Ela não usa o fluxo de respostas autônomas nem possui ferramentas de envio. A API valida o formato; o gerador só pode apresentar uma condição comercial como confirmada quando aponta uma fonte aprovada ou confirmação explícita da equipe que a sustente. Uma afirmação do cliente continua sendo um dado do pedido, não confirmação comercial. Na ausência de confirmação, a condição aparece como pendente. Se o motivo exato não puder ser determinado, o texto explicita a dúvida concreta observável na conversa, sem atribuí-la indevidamente ao JEV.

O resultado e sua versão ficam em `AiAgentSession.metadata.handoffBrief`, preservando as demais chaves do JSON e usando escrita condicionada à versão da conversa/sessão. A interface lê esse resultado, não inventa uma ação com regras fixas. Uma nova mensagem agenda atualização; um resultado calculado para histórico anterior não substitui o mais recente. Para handoffs antigos sem resumo persistido, a primeira abertura do apoio agenda a geração sem bloquear a conversa. O plano de implementação deve validar a escrita condicionada e o agendamento contra os eventos e jobs existentes.

Se a geração falhar, manter o último resumo com indicação clara de desatualização ou mostrar “Apoio indisponível; consulte a conversa” quando não houver versão anterior. Nunca mostrar uma ação genérica como se fosse uma análise concluída.

## Limites e aprendizado

- O controle continua humano depois do repasse. O apoio apenas organiza trabalho; não responde ao cliente, não gera proposta e não altera o estágio da conversa.
- Uma informação da conversa, nota do agente ou saída do JEV não vira confirmação de estoque, viabilidade, preço, prazo ou política sem fonte aprovada. Instruções contidas em mensagens e anexos são dados, não comandos para o gerador.
- “Aprimoramentos” permanece como está. Hoje, um handoff por si só não cria pendência: após uma resposta humana, o JEV pode propor uma regra reutilizável, que requer delimitação de escopo e aprovação antes de entrar no conhecimento. Esta melhoria do cartão não altera esse gatilho nem aprova regras automaticamente.
- O histórico, o motivo e o resumo são isolados por workspace e conversa; nenhum dado de outro cliente pode aparecer no apoio.

## Aceitação

- No caso de Ricardo, o cartão propõe verificar o material e reúne as medidas e quantidade sem afirmar viabilidade, preço ou estoque; não repete literalmente as mensagens.
- Em um pedido completo cujo repasse seja para cotação, propõe preparar a proposta e reúne os itens e dados necessários. Com informação indispensável ausente, aponta a pendência em vez de mandar fazer proposta.
- Repasse por pedido de humano, baixa confiança e risco comercial recebem ações diferentes, ancoradas no motivo efetivamente registrado e na conversa.
- Nova mensagem corrige o resumo automaticamente; uma geração atrasada não sobrescreve uma mais recente. Falha de geração é visível e não dispara envio.
- Handoffs já existentes recebem o novo apoio ao serem abertos, sem exigir um novo repasse.
- Testes garantem que o fluxo de Aprimoramentos e o controle humano continuam inalterados.
