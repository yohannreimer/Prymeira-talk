# Contextual Attachment Warnings Implementation Plan

> Execução sequencial com executing-plans, conforme preferência expressa do usuário. Desenho aprovado na conversa; sem nova rodada de plano técnico.

**Goal:** remover avisos antigos irrelevantes da sugestão e preservar o aviso no próprio anexo.

**Architecture:** relevância estruturada no mesmo chamado do modelo; fallback conservador; estado público mínimo derivado de metadados privados.

**Tech Stack:** TypeScript, Zod, Prisma, React, Vitest.

- [ ] Em `assistant-generation.test.ts`, testar anexo antigo irrelevante sem warning, antigo necessário com warning, decisão ausente/duplicada com warning e anexo do turno atual sempre com warning. Executar `pnpm --filter @prymeira-talk/api test src/modules/assistant/assistant-generation.test.ts` e observar falha antes de implementar.
- [ ] Em `provider-gateway.ts`, aceitar `attachmentRelevance?: {messageId:string,requiredForReply:boolean}[]`. Em `assistant-generation.ts`, coletar `{messageId,createdAt,type,currentTurn}`, manter marcador de não leitura com ID no contexto, solicitar classificação na mesma resposta e filtrar avisos somente com decisão única e explicitamente falsa para anexos fora do turno atual. Persistir também resultado failed no cache vinculado à fonte; não usar cache failed para impedir reteste.
- [ ] Acrescentar teste de `toMessageDto` em `message-attachment-state.test.ts`: import indisponível ou cache failed com hash correspondente resulta em unread; cache processado prevalece e cache de outra URL é ignorado; nenhum metadado privado sai no DTO. Acrescentar campo opcional enum unread ao schema compartilhado e derivação no serviço.
- [ ] Em `InboxPage.test.tsx`, testar que `attachmentReadNotice({attachmentReadStatus:'unread',type:'file'})` retorna aviso e áudio não lido não aparece processando. Em `InboxPage.tsx`, renderizar aviso junto à bolha (áudio usa o próprio texto de erro), mantendo estilos existentes.
- [ ] Executar testes focados, suites API/web/shared e typecheck; criar commit seletivo sem as alterações anteriores de agentes. Verificar o commit isolado e builds API/web.
- [ ] Publicar imagens imutáveis via workflow existente e atualizar somente serviços API/web. Conferir versão, saúde, bolha do anexo e nova sugestão privada do caso real sem enviar nada. Registrar resultados e limites.

Revisão: nenhuma mudança de banco, autonomia, catálogo, prompt comercial ou recuperação de arquivo. Ausência de avaliação não pode esconder alerta. Resultados de qualidade são escopo testado, não garantia semântica universal.
