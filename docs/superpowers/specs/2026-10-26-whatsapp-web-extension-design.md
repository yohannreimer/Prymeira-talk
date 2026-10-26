# Prymeira Talk no WhatsApp Web — piloto 0.1

Desenho aprovado por Yohann no chat em 26/10/2026. Execução neste chat, sem subagentes.

## Objetivo e recorte

Usar, no WhatsApp Web, as sugestões e os follow-ups da conversa correspondente no Talk. O piloto usa um número já conectado ao Talk. O Talk permanece responsável pelo histórico, pela IA, pelo calendário e pela entrega dos acompanhamentos existentes.

## Componentes

- `apps/extension`: extensão Manifest V3; painel React, service worker e dois content scripts limitados ao WhatsApp Web e à rota `/extension` do Talk.
- `apps/web/src/features/browser-extension`: página autenticada `/extension`. O usuário autoriza a conexão. Uma ponte com comandos permitidos consulta as APIs existentes. As credenciais permanecem na página do Talk.
- `apps/api/src/modules/browser-extension`: lista de canais verificados e resolução somente leitura de conversa, atrás do middleware atual de acesso ao produto.
- `packages/shared/src/browser-extension.ts`: comandos e contratos compartilhados, com validação estrita.

## Fluxo

1. O painel abre a página `/extension` do Talk.
2. O vendedor entra com sua conta existente e clica em conectar. A autorização termina ao fechar a aba, sair da conta, mudar a sessão ou revogar o acesso.
3. O adaptador do WhatsApp observa somente a identificação da sessão, cabeçalho e atributos de identificação das mensagens renderizadas. Não lê corpos de mensagens, arquivos, QR codes ou credenciais do WhatsApp.
4. O painel seleciona o canal com o mesmo número verificado. Se houver vários canais, o usuário escolhe explicitamente.
5. O backend valida workspace, canal, número próprio e permissão sobre a conversa. Usa aliases e autoridade canônica existentes; em canais legados aceita apenas correspondência exata por telefone e recusa duplicidades. LIDs não são interpretados como telefones.
6. A última mensagem renderizada deve existir no histórico do Talk antes de disponibilizar sugestões. No histórico unificado, verificar a identidade canônica completa e seu hash indexado, com conteúdo pronto e não oculto; no legado, verificar o ID do provedor dentro da conversa/canal. Ausência de sincronização vira espera explícita.
7. O painel consulta sugestões e follow-up ativo. Gerar sugestão, adiar e cancelar usam as APIs existentes. Inserção no WhatsApp exige nova validação de contexto e campo de mensagem vazio. A extensão não clica em enviar.

## Troca de contexto

Cada observação tem uma chave aleatória. Mudanças de conversa, conta, aba ou mensagem invalidam o conteúdo anterior. Cada painel consulta a aba ativa da própria janela do Chrome; focar outra janela não troca seu contexto. Antes e depois de consultas assíncronas, o worker confirma janela, aba e chave. Respostas de contexto anterior são descartadas. Navegação pela lista limpa o contexto imediatamente e nunca libera a conversa antiga apenas por ter transcorrido um prazo.

## Limites explícitos

- A identificação por DOM/localStorage é um adaptador experimental, ainda dependente de validação no WhatsApp Web real.
- A aba autenticada de conexão precisa permanecer aberta no piloto; não há sessão paralela persistente na extensão.
- Conversas individuais apenas. Contatos não identificados ou vínculos conflitantes permanecem bloqueados.
- API e web do Talk precisam receber esta integração antes de usar a extensão contra produção. Esta tarefa não efetua implantação.
- A sincronização das mensagens enviadas nativamente e a interrupção dos acompanhamentos precisam ser comprovadas com o provedor e número reais antes de liberar o piloto.

## Aceitação

- Identificar corretamente contato e canal; recusar número diferente, grupo, LID sem vínculo e duplicidade.
- Manter isolamento entre empresas e as permissões atuais de atendentes.
- Nunca exibir sugestão atrasada de outra conversa.
- Limpar os dados ao trocar de conta ou perder acesso.
- Preservar edições do vendedor e impedir sobrescrita de rascunho nativo.
- Não executar envios de teste a clientes.

## Validação

Testes unitários do adaptador, resolução e concorrência; testes HTTP com middleware real de autenticação; testes da ponte de comandos; fluxo da extensão carregada no Chromium com autenticação e HTTP simulados e dados exclusivamente sintéticos. O teste sintético não comprova compatibilidade com o DOM atual nem com o provedor de produção.


## Validação no WhatsApp atual — 0.1.1

O DOM real observado em 26/10 expõe `data-id` como stanza hexadecimal sem telefone. Quando o peer não está disponível, a extensão envia somente esse identificador e a identidade da própria conta, com o canal verificado selecionado. O backend exige exatamente uma identidade canônica nesse workspace/canal, tupla íntegra, mensagem visível/pronta, endereço ativo e autoridade operacional ativa. Ausência, conflito, grupo ou revisão bloqueiam a leitura. Não há associação por nome ou escrita de aliases.

A transição sem peer exige mudança tanto do cabeçalho quanto da stanza antes de liberar a nova seleção. Contatos homônimos permanecem bloqueados durante a transição; recarregar o WhatsApp inicia uma nova observação verificável. O nome serve apenas para detectar a troca visual, nunca para resolver uma conversa no servidor.
