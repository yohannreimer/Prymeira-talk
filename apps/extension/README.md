# Prymeira Talk para WhatsApp Web

Piloto 0.2: painel lateral com sugestões da conversa atual, fila de follow-ups e fila Humano necessário. Usa um número que já esteja conectado ao Talk.

## Preparar

Na raiz do monorepo:

Use Node.js 22 e pnpm **10.0.0**, conforme `packageManager` do projeto, para preservar a configuração do lockfile.

```sh
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm --filter @prymeira-talk/extension build
```

O build usa `https://talk.prymeiradigital.com.br`. Para um ambiente local, compile com `TALK_EXTENSION_ORIGIN=http://localhost:5176 pnpm --filter @prymeira-talk/extension build`. A origem fica fixa no pacote; não aceita URLs de API enviadas pelo WhatsApp.

**Requisito:** publicar ou executar a API e o web deste commit. Instalar somente a extensão sobre um Talk sem as rotas `/browser-extension/*` e a página `/extension` não habilita a integração.

## Instalar o piloto

1. Abra `chrome://extensions` e ative o modo do desenvolvedor.
2. Clique em **Carregar sem compactação** e selecione `apps/extension/dist` (ou a pasta extraída do ZIP entregue).
3. Abra o WhatsApp Web e clique no ícone da extensão para abrir o painel lateral.
4. Clique em **Conectar minha conta**, entre no Talk e autorize a conexão na aba aberta.
5. Mantenha essa aba do Talk aberta e volte ao WhatsApp Web com o mesmo número conectado no Talk.
6. Abra uma conversa individual. Se houver mais de um canal correspondente, escolha o canal.

As abas **Conversa**, **Follow-ups** (contador vermelho de itens para revisar) e **Humano necessário** acompanham o canal verificado do WhatsApp aberto. As filas têm paginação e atualização; atendentes veem somente conversas atribuídas.

Em **Follow-ups → Para revisar**, clicar em um item abre o contato no WhatsApp Web, comprova a conversa e revalida a revisão do acompanhamento. O texto é colocado no campo vazio; você lê, edita e aperta **Enviar** no próprio WhatsApp. Um rascunho já existente é preservado. Navegação ou digitação durante a preparação interrompe a operação. O preparo expira em um minuto. A extensão não cria um segundo disparo nem marca o item como enviado antecipadamente; a atualização no Talk depende da sincronização do envio nativo.

**Lembretes** e **Agendados** abrem a conversa sem preparar mensagem nem antecipar o agendamento. **Humano necessário** mostra o motivo e abre a conversa; abrir não conclui a pendência humana.

O painel mostra a sugestão existente e permite pedir outra, editar e inserir no campo vazio do WhatsApp. O vendedor revisa e envia. Follow-ups já existentes podem ser consultados, adiados ou cancelados; lembretes internos podem ser marcados como feitos. Não há botão de disparo automático na extensão.

## Identificação e acesso

O backend confere o número verificado do canal e resolve aliases, incluindo LID quando há vínculo conhecido. Nunca associa por nome. Atendentes continuam sujeitos às permissões da IA de apoio do Talk. Mensagens observadas precisam ter chegado ao Talk para liberar o contexto.

A extensão usa somente `sidePanel`, `storage` e acesso às origens do WhatsApp Web e do Talk. Não recebe o token de login: as requisições autenticadas acontecem na página do Talk. Fechar essa aba, sair, trocar a conta ou perder acesso encerra o vínculo. Estado temporário fica em `chrome.storage.session`.

## Testar

```sh
pnpm --filter @prymeira-talk/extension test
pnpm --filter @prymeira-talk/extension exec playwright install chromium
pnpm --filter @prymeira-talk/extension test:browser
```

O teste de navegador carrega a extensão real, a página de conexão real e os dois content scripts. Somente autenticação, HTTP e a tela do WhatsApp são fixtures com dados sintéticos; nenhuma mensagem real é enviada. Os resultados ficam em `.validation/extension-browser` na raiz, ou em `BROWSER_OUTPUT_DIR`.

## Limites do piloto

- O DOM observado expõe a stanza sem telefone. O resolver exige uma identidade canônica única e sincronizada no canal; identidades indisponíveis bloqueiam o contexto e a preparação.
- Grupos e número ainda não conectado ao Talk ficam fora do recorte.
- Validar no número piloto a coexistência com o provedor, o espelhamento dos envios nativos e o cancelamento dos acompanhamentos após resposta.
- A aba de conexão precisa continuar aberta. Publicação na Chrome Web Store e login independente da aba são etapas futuras.
- Não habilitar envios nem alterar cadências do Talk apenas por instalar a extensão.
