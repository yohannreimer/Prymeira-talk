# Leads: Google Maps e Receita Federal

## Objetivo

Adicionar o módulo **Leads** ao Prymeira Talk para encontrar empresas, validar explicitamente números de WhatsApp e transformar apenas os leads escolhidos em contatos de prospecção prontos para uma abordagem manual ou para uma campanha já governada por **Disparos**.

O módulo terá duas fontes de descoberta:

- **Google Maps** para empresas locais encontradas por nicho e cidade;
- **Receita Federal** para pesquisa estruturada na base pública de CNPJ.

Uma única base pública da Receita servirá todos os workspaces. Buscas, listas, resultados importados, verificações de WhatsApp e contatos permanecem estritamente isolados por workspace.

## Escopo aprovado

### Navegação e listas

- Incluir **Leads** como um módulo da navegação principal.
- O módulo terá duas abas de fonte: **Google Maps** e **Receita Federal**.
- **Minhas listas** será uma entrada persistente no cabeçalho, não uma terceira fonte. Ela mostra somente as listas do workspace atual, seus progressos, resultados e erros.
- Cada busca cria uma `LeadList` privada, com fonte, critérios, criador, data, estado do job e uma fotografia dos resultados encontrados.
- Todos os papéis existentes (`owner`, `manager` e `agent`) podem executar todas as ações de Leads dentro do próprio workspace.

### Google Maps

- O usuário informa atividade/nicho e cidade. A busca cria um job assíncrono no adaptador do scraper baseado no `google-maps-scraper-kit`.
- A coleta é conservadora: uma busca por vez no scraper, profundidade inicial 5 e avisos claros quando houver rate limit, bloqueio temporário ou resultado parcial.
- O resultado inicial conserva somente os campos necessários para prospecção: nome, categoria, endereço, cidade/UF, telefone, website, avaliação, número de avaliações, coordenadas quando disponíveis e URL/origem da coleta.
- Resultados do Maps não criam contatos automaticamente.

### Receita Federal

O módulo recebe uma base compartilhada e somente de leitura, alimentada mensalmente pelo `cnpj-data-pipeline` em PostgreSQL separado do banco operacional do Talk. A carga usa o snapshot público mensal da Receita e mantém os dados de empresa, estabelecimento, CNAE, porte, capital social, natureza jurídica, Simples, situação cadastral, endereço, telefone e e-mail.

O componente do pipeline será fixado em uma versão MIT verificada e terá seu aviso de licença registrado no projeto antes do deploy. O schema suporta CNPJ alfanumérico, sem pressupor que todos os CNPJs tenham somente dígitos.

A aba oferece três entradas, todas gerando uma lista privada:

1. **Cidade + atividade/CNAE**: filtra município, UF, CNAE principal ou secundário, porte, situação ativa, faixa de abertura, faixa de capital e presença de telefone/e-mail.
2. **Empresa ou CNPJ**: localiza uma empresa/estabelecimento específico e permite iniciar uma busca de semelhantes.
3. **Importar CSV**: recebe uma coluna `cnpj` com valores formatados ou não. Linhas válidas são enriquecidas na lista; repetidas não são duplicadas; inválidas ou ausentes retornam em um CSV de erros por linha. A importação não cria contatos.

### Empresas semelhantes

A ação **Encontrar semelhantes** recebe uma empresa semente e consulta estabelecimentos ativos, excluindo o próprio CNPJ e as demais filiais da mesma raiz de CNPJ. Ela retorna uma nota explicável de 0 a 100, acompanhada dos fatores que a formaram:

| Componente | Peso | Sinais |
| --- | ---: | --- |
| Atividade | 35 | CNAE principal, CNAEs secundários e equivalências de setor. |
| Localização | 25 | Cidade, UF e distância, quando existir geolocalização. |
| Perfil empresarial | 20 | Porte, faixa de capital, natureza jurídica, opção pelo Simples e idade da empresa. |
| Prontidão comercial | 20 | Situação ativa, endereço suficiente e presença de telefone/e-mail. |

Os pesos são apresentados como regra inicial e os filtros podem restringir a busca. Cada resultado mostra a decomposição: por exemplo, “mesmo CNAE principal, mesma cidade, porte semelhante e telefone disponível”. Informações de um workspace nunca influenciam a nota, o candidato ou a ordem mostrada a outro workspace.

### Validação no WhatsApp

- A verificação é uma ação explícita sobre os números selecionados, usando a instância Evolution vinculada ao workspace.
- Ela normaliza o telefone antes de consultar o endpoint de disponibilidade da versão instalada do Evolution e **não envia mensagens**.
- Estados visíveis: `não verificado`, `verificando`, `WhatsApp verificado`, `sem WhatsApp` e `erro temporário`.
- A execução ocorre em jobs limitados por instância, com lote padrão máximo de 25 números, duas retentativas com backoff para falhas transitórias e a possibilidade de tentar novamente apenas os itens com erro.
- A ausência de uma instância Evolution conectada impede somente a verificação; a busca e a criação de lista continuam disponíveis.

### Contatos e prospecção

O botão da lista será **Cadastrar contatos**, nunca “Enviar para Contatos”. Para cada lead selecionado:

- criar ou reconciliar um contato apenas no workspace atual, usando o telefone normalizado e CNPJ quando houver;
- aplicar uma tag visível `Origem: Lead Google` ou `Origem: Lead Receita`;
- registrar origem, nome da lista, data de importação, URL/código de origem e estado da verificação de WhatsApp em uma proveniência de lead associada ao contato;
- preservar dados já existentes do contato e evitar duplicação;
- associar o modelo editável **Prospecção — Clínica padrão** como rascunho de mensagem. Abrir o contato coloca esse texto no compositor, mas não o envia.

Para múltiplos contatos, **Criar lote de disparo** encaminha os IDs selecionados e o modelo escolhido ao módulo existente de Disparos. Somente Disparos executa o envio, aplicando os limites, aprovações, elegibilidade de canal/template, bloqueios e regras de campanha já existentes. Leads não podem disparar mensagens diretamente.

## Arquitetura

```text
Google Maps scraper ──────┐
                           ├─> jobs de descoberta ─> LeadList/Lead (por workspace) ─> Contato / Disparos
Receita Federal mensal ─> pipeline CNPJ ─> PostgreSQL público de CNPJ (compartilhado, somente leitura)
                                                   │
                                                   └─> busca Receita e ranking de semelhantes

Evolution do workspace ─> job de disponibilidade de WhatsApp ─> estado do número no Lead
```

### Limites de dados

- A base de CNPJ é um banco/schema próprio, com usuário de leitura para o backend do Talk; ela não recebe listas, notas internas, mensagens ou dados de clientes.
- `LeadList`, `Lead`, verificações, importações, proveniências e vínculos com contatos sempre carregam `workspaceId` e são filtrados por ele no serviço e nas rotas.
- Os resultados de uma lista mantêm um snapshot dos campos exibidos, para que uma atualização mensal da Receita não altere retroativamente a lista que o cliente analisou.
- A atualização pública mensal é um job operacional independente. O módulo exibe o mês da última competência disponível; uma falha de atualização preserva a última base íntegra e não bloqueia buscas.

### Jobs e estados

Busca Maps, importação CSV, cálculo de semelhantes e verificação de WhatsApp são jobs persistentes. Eles têm estados `queued`, `running`, `completed`, `partial` e `failed`, contador de itens e uma mensagem de erro segura para o usuário.

- Falha parcial mantém os resultados válidos e lista os itens falhos.
- Importação CSV oferece download do arquivo de erros.
- Busca Maps mostra o motivo quando o provedor limitar/bloquear a coleta e permite nova tentativa após o intervalo informado.
- Jobs interrompidos podem ser retomados de modo idempotente, sem duplicar leads, verificações ou contatos.

## Segurança, privacidade e conformidade

- Todo perfil possui acesso ao módulo, mas nenhuma rota pode ler ou alterar recursos de outro workspace.
- A base pública nacional é usada apenas para pesquisar empresas; ela não é exportada automaticamente em massa.
- A consulta de WhatsApp não transmite conteúdo de conversa nem aciona envio de mensagem.
- Importar ou cadastrar contato não inicia uma campanha. Uma campanha nasce somente quando o usuário escolhe **Criar lote de disparo**, e permanece sujeita às salvaguardas existentes do módulo de Disparos.
- A interface informa a origem do dado e o estado de disponibilidade; um telefone “verificado” significa apenas que a consulta ao Evolution o identificou como WhatsApp disponível, não consentimento para receber mensagens.

## Tratamento de duplicidade

- Dentro de uma lista, um mesmo resultado de fonte é único por identificador externo ou CNPJ/telefone normalizado.
- Ao cadastrar contato, o sistema procura primeiro o contato existente do workspace pelo telefone normalizado e, na ausência dele, pelo CNPJ registrado na proveniência de lead.
- Se encontrado, atualiza a proveniência e as tags sem apagar campos preenchidos pelo usuário. Se não encontrado, cria o contato.
- Uma empresa pode aparecer em listas diferentes do mesmo workspace, mas mantém um único contato quando for cadastrada.

## Testes e critérios de aceite

### Serviços e dados

- Testar filtros da Receita, CNPJ alfanumérico, CSV válido/inválido/repetido e o snapshot de resultados.
- Testar cálculo do ranking, pesos que somam 100, exclusão da própria raiz CNPJ e explicação dos sinais.
- Testar carga/consulta da base pública por um conjunto de dados reduzido e a indicação da competência carregada.

### Isolamento e fluxo

- Testar que cada rota de lista, lead, job, verificação e proveniência rejeita recursos de outro workspace para todos os perfis.
- Testar deduplicação e reconciliação de contato sem sobrescrever campos existentes.
- Testar a criação de tags e proveniência Google/Receita e o rascunho da mensagem Clínica padrão.
- Testar que criar lote delega para Disparos e que nenhuma rota de Leads envia mensagem.

### Integrações e interface

- Testar o adaptador Maps em respostas completas, parciais, rate limited e falhas.
- Testar o adaptador Evolution para número disponível, indisponível, instância ausente, timeout e retentativa.
- Testar estados visuais de fila, progresso, erro por linha de CSV, retry e criação de contato/lote.

## Fora de escopo nesta entrega

- Scraping de Instagram, LinkedIn, TikTok ou Meta Ads.
- Enriquecimento automático por redes sociais ou geração de texto por IA além do modelo editável Clínica padrão.
- Envio automático de mensagens a partir de Leads.
- Bases públicas separadas por cliente ou qualquer compartilhamento de listas entre workspaces.
