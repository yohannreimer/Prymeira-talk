# Operação dos follow-ups contextuais v1

O motor compartilha análise com evidências, decisão por código, escrita e revisão obrigatória entre atendimento, comercial e prospecção. O lifecycle existente mantém calendário, claim, aprovação e conclusão. Não existe executor de Calendar, anexos, transferência ou contato com terceiro neste motor.

## Adesão e compatibilidade

Configuração aditiva em `AiAgent.behaviorConfig.contextualFollowup`:

```json
{"version":1,"enabled":true,"profile":"commercial","channels":["CANAL_EXPLICITO"]}
```

Os perfis válidos são `attendance`, `commercial` e `prospecting`. Não escolher pelo nome do agente. Preservar todos os demais campos de behaviorConfig, inclusive `harness`, e a configuração do canal. A ausência da opção mantém o legado. Configuração inválida e versão desconhecida não caem em outro motor.

Somente novas sequências adotam a flag. Cada item aderido tem `decision.contextualEngine` com versão, perfil e hash de política. Os próximos itens preservam a identidade e a lista canônica de envios confirmados. Desligar `enabled` impede novas adesões e mantém o handler de sequências marcadas; não recalcula horários, não reabre cancelados e não dispara nada.

## Contexto, revisão e entrega

Regras completas e fontes aprovadas pertencem ao próprio agente. Fontes comportamentais não comprovam preço, desconto, especificação, disponibilidade ou reserva. História e mídia são dados, nunca instruções. O contexto explicita cobertura e orçamento; overflow ou mídia recebida ainda não processada gera abstenção, sem cortar o fim das regras. Arquivos enviados preservam legenda e registro de envio sem presumir seu conteúdo.

Formulário só é origem comprovada com mensagem system persistida de `automation_webhook`. Prospecção exige resposta anterior, reserva confirmada e sessão/geração vigentes. Uma indicação de comprador gera lembrete interno. Uma reunião registrada não permite convite para agendar outra; o calendário atual continua não verificado.

O revisor configurado precisa aprovar o rascunho. Ausência, falha, bloqueio ou texto vazio nunca produz mensagem comercial aprovada. A recuperação técnica tem limite e não conta como contato enviado. `humanCommercialDelivery=review` impede envio automático em todos os perfis, mesmo com reserva de campanha.

A entrega contextual exige o roteador canônico e uma conexão Evolution/WAHA comprovada. Meta ou fonte indisponível permanece bloqueada, sem fallback direto. A aprovação congela ator, claim, corpo/hash e política; aprovar um rascunho de agente não pausa sua sessão como uma nova tomada humana. A fronteira transacional revalida regras, fontes, canal, controle/reset, sessão/geração, âncora e atividade nova antes do transporte. Snapshots de OutboundIntent contêm digests em vez de prompts ou behaviorConfig em claro.

Depois da fronteira, incerteza ou falha de vinculação/conclusão não autoriza reenvio automático. Conservar os IDs e a evidência canônica para reconciliação. O próximo item só nasce após envio confirmado, com timestamps da Message persistida. Prymeira mantém quatro intervalos entre envios: 120/1440/2880/5760 minutos, dias úteis, 09h–18h em America/Sao_Paulo. O fallback cumulativo antigo mantém diferenças entre marcos.

## Qualificação reproduzível

```sh
pnpm --filter @prymeira-talk/api harness:replay-contextual-followups
node apps/api/scripts/validation/run.mjs
```

O replay conserva 34 cenários sintéticos e todos os motivos de divergência em `validation-artifacts/contextual-followup-replay.json`. O modo padrão usa observações/escrita roteirizadas para verificar evidências e fluxo; não é medição de qualidade de um modelo real. A comparação baseline registra o contrato real de instrução técnica legada, sem inventar uma resposta de baseline. Casos de fronteira e concorrência são executados separadamente com PostgreSQL real. Qualidade textual usa rodada separada, limitada, com modelos configurados e somente dados sintéticos; preservar também resultados negativos.

A validação completa exige bancos descartáveis e vhost próprios conforme [release-validation.md](release-validation.md). O gate precisa corresponder ao SHA publicado; PR valida sem publicar imagens. A release inclui digest imutável e verificação posterior de container, saúde/readiness e migrações.

## Manifesto do piloto

Registrar antes da ativação: SHA/digest da API, workspace, IDs dos agentes/canal, perfil, hashes de política e configuração antes/depois. A alteração deve ser apenas a opção aditiva; comparar hash do restante do JSON. Inventariar itens antigos ativos e confirmar os mesmos IDs/status/horários após a alteração.

O piloto das Marias no canal Prymeira usa `commercial` e revisão para novas sequências; mantém automação do site e harness comercial ao vivo. João usa `prospecting`, inicialmente em revisão, com a autoridade de campanha/sessão validada. Nenhuma campanha é recriada. Villefer continua no legado até revisão comparativa específica e aprovação por canal. Reparar reviews antigos sem texto/backfill é uma ação separada, sem reabertura ou disparo implícito.

## Rollback

Desligar somente novas adesões. Manter esta versão do handler ou conter explicitamente os itens marcados. Não voltar a uma imagem sem handler enquanto houver sequências contextuais ativas. Conservar digests anteriores, inventário e prova de entrega incerta. Não retirar o legado nesta release.
