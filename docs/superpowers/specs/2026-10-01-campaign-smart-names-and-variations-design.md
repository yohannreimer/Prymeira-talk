# Disparos: nome inteligente e variações de mensagem — desenho

Data: 2026-10-01. Base: produção `72bbb63`. Branch: `codex/talk-campaign-smart-names-20261001`.

## Objetivo

Reduzir bloqueios de WhatsApp e erros de tratamento nos disparos de campanha:

1. Usar o primeiro nome do contato só quando for uma pessoa. Empresa, setor ou nome ausente: a mensagem sai sem nome, sem frases quebradas.
2. A partir de uma mensagem, gerar 5 variações revisáveis pelo usuário, para que os destinatários não recebam textos idênticos.

## Estado atual (verificado no código)

- `renderTemplate` (`apps/api/src/modules/campaigns/campaigns.service.ts`) substitui `{{nome}}` por `contact.name` completo ou por `fallbackName` ("cliente").
- A campanha já aceita até 6 `templates` e alterna por destinatário (`index % templates.length`). O editor (`GuidedCampaignEditor.tsx`) envia só 1.
- Os planos de destinatários (`buildRecipientPlans`) são gerados na verificação e na ativação.
- A IA do workspace é resolvida por `resolveOpenAiCompatibleSettings` (`modules/agents/ai-provider-settings.ts`); `luna-structured-analysis.ts` e `openai-agent-improvement.ts` mostram o padrão de chamadas com saída JSON.

## Decisões aprovadas

- `{{nome}}` muda de significado em todas as campanhas (inclusive rascunhos e antigas): primeiro nome se for pessoa, vazio caso contrário.
- A IA classifica uma vez e o resultado é guardado no contato (abordagem A).
- Variações exigem revisão do usuário antes de salvar. Nada é enviado automaticamente.

## Unidades

### `name-insight` (API, `modules/campaigns/name-insight.ts`)
- Entrada: lista de nomes e as configurações da IA do workspace.
- Saída por nome: `{ kind: "person" | "company" | "unknown", firstName: string | null }`.
- Faz chamada em lote (até 40 nomes por requisição) com resposta em JSON validada por schema (zod). Resposta inválida ou ausente: `unknown`.
- Regras fixas no prompt: "Fulano - Empresa" devolve o primeiro nome de Fulano; setores ("Compras", "Vendas", "ADM", "SAC") sem nome pessoal são `company`; emojis e símbolos são removidos do nome devolvido; nunca inventar nome.

### Persistência
- No contato: `customFields.nameInsight = { sourceName, kind, firstName, classifiedAt }`. Sem migração.
- Reclassifica quando `sourceName` difere do nome atual do contato.
- Linhas de audiência sem contato salvo (planilha importada) são classificadas em memória, sem persistir.

### `renderTemplate` (ajuste)
- `{{nome}}` e `{{name}}` resolvem para `firstName` se `kind === "person"`; caso contrário, vazio.
- Se a campanha tiver `fallbackName` preenchido explicitamente, ele é usado no lugar do vazio. O valor implícito "cliente" deixa de ser usado.
- Pós-processamento do texto renderizado: remove espaço antes de `, . ! ? : ;`, colapsa espaços repetidos e remove espaço no início/fim de cada linha. Exemplo: "Olá {{nome}}, tudo bem?" vira "Olá, tudo bem?".

### Orquestração
- Na verificação de destinatários e na ativação, antes de `buildRecipientPlans`, o serviço seleciona os contatos sem `nameInsight` válido, chama `name-insight` em lote e grava os resultados.
- IA não configurada, indisponível ou com erro: segue sem nome para todos e marca `nameCheck: "unavailable"` na resposta do preview.

### `message-variations` (API, `modules/campaigns/message-variations.ts`)
- Endpoint: `POST /campaigns/message-variations`, corpo `{ message }`, resposta `{ variations: string[] }` com 5 itens.
- Prompt: manter sentido, tom, link/telefone e campos `{{...}}`; variar saudação, ordem e vocabulário; não prometer o que a original não promete.
- Validação por variação: mesmos campos `{{...}}` da original (multiconjunto), no máximo 2000 caracteres, não idêntica a outra variação nem à original (comparação após normalização). Variação inválida é regenerada uma vez; persistindo, o endpoint devolve erro claro.

### Editor (web, `GuidedCampaignEditor.tsx`)
- Botão "Inserir nome" no campo Mensagem, com dica "empresas ficam sem nome".
- Seção "Variações (n de 6)": cada texto editável, regenerar uma variação, remover, e aviso quando faltar algum campo `{{...}}`.
- Ao salvar, `templates` recebe a mensagem original e as variações (máximo 6).
- Preview por destinatário mostra o texto final renderizado e o selo "Nomes não verificados pela IA" quando aplicável.

## Erros e limites

- Falha da IA nunca bloqueia o disparo: sem nome é o comportamento seguro.
- Custo: uma chamada por lote de nomes novos e uma por geração de variações. Contatos já classificados não geram novas chamadas.
- Fora de escopo: alterar cadência/horários, rotação aleatória em vez de alternada, personalização por outros campos, classificar contatos fora de campanhas.

## Testes

- `name-insight`: pessoa, empresa, "Pessoa - Empresa", setor, vazio, emoji, resposta inválida, lote parcial.
- `renderTemplate`: com e sem nome, pontuação, `fallbackName` explícito, nome com espaços.
- Orquestração: cache por `sourceName`, reclassificação ao mudar o nome, falha da IA.
- `message-variations`: preservação dos campos, descarte de duplicadas, regeneração, limite de tamanho.
- Editor: inserir nome, gerar e editar variações, salvar até 6 templates, aviso de campo ausente.

## Entrega

Implementar na branch nova, rodar typecheck, testes e build. Abrir PR em draft. Publicação em produção só com autorização do usuário, pelo mesmo procedimento de imagens (GitHub Actions + Portainer) e com reversão para a imagem `72bbb63`.
