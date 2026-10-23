# Atendimento que acolhe e conduz

Pedido aprovado por Yohann em 23/10/2026 nesta sessão: cumprimentar e puxar atendimento, eliminar agradecimento automático de contato e ressalvas sobre dúvidas que ninguém perguntou, revisar desvios e testar as conversas históricas antes de publicar.

## Comportamento

- Saudação isolada inicia uma abertura útil: devolver a saudação e perguntar como ajudar. Lista ou pedido junto da saudação recebe atendimento direto, aproveitando os dados existentes.
- Não usar agradecimento genérico de contato como resposta. Agradecer um dado ou despedida real continua permitido.
- Separar pedido de cotação de pergunta explícita sobre disponibilidade, preço, frete ou norma. Uma lista não exige narrar que uma variante ainda depende de confirmação. Manter pendências internas e responder honestamente quando o cliente perguntar diretamente.
- Recusa integral comprovada pela base não deve ganhar perguntas de medida, cidade ou cadastro. Pedido misto continua nos itens atendidos. Pedido explícito de pessoa permanece prioritário.
- Preservar proteção contra fatos inventados, pagamentos, estoque, promessas de retorno, injeção e loops.

## Implementação escolhida

Corrigir classificação de saudação no núcleo e impedir que a segunda classificação a transforme novamente em despedida. Criar jogada de acolhimento no atendimento. Alinhar instruções do leitor, redator e juiz; validar abertura útil e agradecimento genérico por regras pequenas. Marcar intenção de qualificação em dados estruturados da jogada, sem ligar validação pela presença de uma frase em texto livre. Não reescrever todo o motor nem substituir respostas por templates.

## Validação

Regressões determinísticas antes/depois para saudações, despedidas, bots, injeção, recusas integrais/mistas, agradecimentos e perguntas factuais diretas. Rodar conjunto de harness e typecheck/build. Reproduzir todos os 68 pontos exportados, cortando cada histórico antes da resposta avaliada; modelo e JEV reais sem transporte, ações ou persistência. Preservar resultados completos e comparar respostas com o histórico observado. Dados de clientes ficam fora do Git. Publicação somente após revisão das gerações e verificações aprovadas; confirmar novamente a imagem ativa antes de implantar para preservar mudanças concorrentes.

## Refinamentos de implementação observados nos testes

A intenção de solicitação é preservada como dado estruturado opcional, compatível com fichas antigas. Repetição e ressalvas são julgadas semanticamente contra a conversa real, sem confundir citações e perguntas internas com falas do cliente. As verificações factuais recebem as fontes completas. A recusa integral é conservadora: citações de atendimento ou consulta impedem tratar um pedido agrupado como todo recusado. O fallback de vídeo informa o tipo real da mídia.
