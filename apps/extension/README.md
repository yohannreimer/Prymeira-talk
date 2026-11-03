# Prymeira Talk para WhatsApp Web

Versão 0.3.1: direção visual Talk claro com Prym original e logo Prymeira. Conversa exibe identidade e sugestão de resposta; Follow-ups mostra apenas Para revisar; Humano necessário exibe motivos legíveis. A linha principal das filas abre a conversa com uma seta discreta. Ações de texto separadas permitem cancelar o follow-up e desmarcar humano necessário.

## Conexão de produção

O build padrão usa a chave **pública** Clerk e as origens fixas de `production-auth.json`. O SDK oficial `@clerk/chrome-extension` sincroniza a sessão já autenticada no domínio Clerk e renova tokens no service worker. A autorização da extensão fica em `chrome.storage.local`, limitada a contextos confiáveis; scripts de conteúdo não recebem credenciais. Cada comando continua passando pela verificação de produto do Talk e pelas permissões existentes.

Clique Conectar minha conta. Se já houver login válido, a conexão pode ser concluída no painel. Se for necessário entrar no Talk, faça o login e volte ao WhatsApp. Depois de conectar, a aba do Talk não sustenta a autorização da extensão. Sair no painel remove a autorização local; não encerra a conta do Talk em outros lugares. Troca de usuário/sessão/empresa e revogação de acesso exigem nova conexão.

Permissões: sidePanel, storage e cookies; origens WhatsApp Web, Talk e `https://clerk.prymeiradigital.com.br/*`. O Chrome concede cookies sobre os sites autorizados; o código de autenticação usa o recurso no domínio Clerk. Antes de ativar uma atualização com essas permissões em uma instalação existente, obter a confirmação do usuário. O ID estável da extensão precisa ser aceito pelo verificador Clerk do Hub. O Account usa CORS_ORIGINS também como authorizedParties: conservar as origens existentes e acrescentar somente chrome-extension://adkhhaecolhjlghpcldmpcnbempabbnl nesta instalação piloto. A configuração foi conferida e aplicada no serviço Account; uma futura republicação da stack deve preservar essa entrada. Registrar a origem na instância Clerk também pode ser necessário em outras instalações. A API nativa da instância já foi observada como habilitada; nenhum relaxamento dessa configuração foi feito nesta tarefa.

## Build e instalação

Use Node 22 e pnpm 10.0.0, conforme o packageManager do monorepo.

```sh
pnpm install --frozen-lockfile
pnpm --filter @prymeira-talk/extension build
```

Carregue `apps/extension/dist` em `chrome://extensions`. O pacote contém a arte original extraída do PDF fornecido pelo usuário, sem depender de imagens ou fontes remotas. Na instalação do piloto já existente, conservar o mesmo diretório registrado no Chrome.

O build permite sobrescrever TALK_EXTENSION_ORIGIN, TALK_EXTENSION_CLERK_PUBLISHABLE_KEY e TALK_EXTENSION_CLERK_ORIGIN. A origem Clerk deve corresponder à chave pública. Ambientes locais sem configuração Clerk continuam com a ponte de página, para compatibilidade de testes; essa variante requer manter a página de conexão aberta.

## Comportamento

Inserir uma sugestão e abrir um follow-up apenas preparam o campo do WhatsApp. O usuário revisa e envia pelo botão nativo. Texto na origem não bloqueia abrir outra conversa; campo de destino ocupado não é sobrescrito. Identidade canônica, revisão e edição/navegação manual continuam protegidas. Nenhuma rota de envio foi adicionada.

Cancelar follow-up usa a revisão exata do item e o cancelamento existente do Talk. Desmarcar humano necessário conclui a pendência com complete_handoff_action e mantém o atendimento sob controle humano; não libera a IA. Ambas as ações revalidam conta, canal e item, aguardam sucesso antes de retirar a linha e atualizam os contadores. Falhas mantêm o item disponível. Nenhuma dessas ações navega no WhatsApp ou altera seu campo de mensagem.

Prym acompanha sugestões e orientações iniciais; não é um novo agente nem um chat separado. O nome do agente configurado no canal continua identificado. Avisos concluídos somem após cinco segundos ou podem ser dispensados. Carregamentos, estados vazios, foco e movimento reduzido têm apresentação própria.

## Verificação

```sh
pnpm --filter @prymeira-talk/extension test
pnpm --filter @prymeira-talk/extension test:browser
TEST_NATIVE_AUTH=1 pnpm --filter @prymeira-talk/extension test:browser
```

Chromium carrega a extensão e a ponte reais com dados sintéticos; autenticação/HTTP/WhatsApp são fixtures. Na variante nativa, somente o adaptador SDK é substituído por uma sessão sintética, enquanto conexão, armazenamento, worker, comandos e regras de invalidação são os reais. A prova de login real precisa ser registrada separadamente; testes sintéticos não comprovam configuração externa Clerk.

Referências: https://clerk.com/docs/guides/sessions/sync-host e https://clerk.com/docs/reference/chrome-extension/create-clerk-client.
