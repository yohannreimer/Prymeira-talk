# Pré-qualificação sem terceirizar a conversa

Pedido explícito do usuário: retirar referências rotineiras a vendedor, avaliação e confirmação durante a coleta. O agente representa a empresa, responde fatos conhecidos e qualifica o pedido antes do repasse. Recusas explícitas permanecem diretas. Não inventar fatos desconhecidos.

- [x] Registrar na ficha um resumo, faltantes e divergências para o repasse; o leitor atualiza essa avaliação a cada turno. Sem dado novo de schema ou banco: permanece na ficha JSON existente.
- [x] Coletar enquanto houver dados necessários, sem repasse automático só por pergunta sem base. Encaminhar quando pronta, impedida ou por pedido explícito de pessoa; preservar motivos excepcionais existentes.
- [x] Alinhar redator e juiz: não anunciar vendedor/avaliação/confirmação sem repasse real; não despejar ressalvas não perguntadas. Pedido de especificação desconhecida é registro do que o cliente quer, não garantia de fornecimento. Revisar conclusão prematura da qualificação.
- [x] Regressões, testes, tipos/build e nova rodada real dos mesmos 15 cenários; incluir diálogo completo até repasse. Sem WhatsApp, escrita no banco ou deploy.

## Validação observada

- API final: 2.925 testes aprovados, 798 ignorados; tipos e build aprovados.
- Rodada exploratória real: os 15 cenários anteriores e 1 adicional, total de 21 mensagens. Preservada; revelou faltantes internos misturados a dados do cliente, condições de outro item e promessa de encaminhar sem repasse.
- Após correção, validação dirigida real com 7 cenários/10 mensagens: zero bloqueios finais, zero referências a vendedor/comercial/responsável durante coleta, um repasse indicado com ficha pronta e divergências registradas. Inclui resposta direta à torneira fora da linha e recusa de Porto Alegre sem prosseguir a coleta.
- A validação dirigida não repete todos os 16 cenários com a versão final. Relatório mostra ambas as rodadas e suas versões, sem descarte de resultados. Perguntas de aceite ainda podem ser mais concisas em algumas respostas.
- Código candidato validado: 22e65c1af9392b3ccfcc423d30d2d6d5f0cff89f. Não houve deploy, escrita no banco, criação de cotação ou envio WhatsApp.
