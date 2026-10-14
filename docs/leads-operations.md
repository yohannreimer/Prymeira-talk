# Operação do módulo Leads

O módulo Leads permite buscar empresas no Google Maps ou na base pública de
CNPJ, verificar números na Evolution sob demanda e cadastrar somente os leads
selecionados como contatos. Cada lista, job, verificação, contato e rascunho é
isolado pelo `workspaceId` autenticado. `owner`, `manager` e `agent` podem usar
Leads; iniciar um disparo continua sujeito às regras próprias de Disparos.

## Preparação

1. Aplique as migrações do Prymeira Talk e gere o cliente Prisma (`pnpm
   prisma:migrate` e `pnpm prisma:generate`). Mantenha backup do banco
   operacional antes de migrações.
2. Para a Receita, configure o stack separado em
   [`infra/leads-cnpj/README.md`](../infra/leads-cnpj/README.md). O pipeline
   está fixado no commit `79a11af4b708d5562beca83f6efb32bb3fd5e8fb`
   (`v1.38.9`). A origem **não possui licença MIT verificada**; o uso interno
   foi autorizado pelo responsável do produto. Não o redistribua como MIT.
3. Carregue a competência mais recente com `./update-cnpj-data.sh`. Repita
   mensalmente depois da publicação dos arquivos da Receita. Registre a
   competência e o horário de conclusão, monitore espaço em disco e faça
   backup/validação da base antes de substituir uma carga utilizável.
4. Crie uma credencial de banco com apenas `CONNECT`, `USAGE` no schema
   `cnpj` e `SELECT` nas tabelas; a API não deve usar o usuário de carga.
   Configure `CNPJ_DATABASE_URL` no ambiente da API. A conexão impõe
   transações somente leitura. A base CNPJ é pública e compartilhada; dados de
   clientes nunca devem ser gravados nela.
5. Para Google, execute o sidecar privado fixado no
   [`docker-compose.dev.yml`](../docker-compose.dev.yml) em desenvolvimento ou
   na [stack Swarm isolada](../infra/leads-google-maps/README.md) em produção,
   e configure `GOOGLE_MAPS_SCRAPER_URL` para a API. O sidecar não tem autenticação:
   exponha-o apenas em loopback ou rede interna, nunca na internet. Seus
   créditos/licença MIT e revisões estão em
   [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

Exemplo local (substitua senha por segredo fora do Git):

```dotenv
CNPJ_DATABASE_URL=postgresql://prymeira_cnpj_reader:<secret>@127.0.0.1:5436/cnpj?options=-c%20search_path%3Dcnpj
GOOGLE_MAPS_SCRAPER_URL=http://127.0.0.1:8080
LEAD_GOOGLE_MAX_CONCURRENT_JOBS=1
LEAD_GOOGLE_DEFAULT_DEPTH=12
LEAD_WHATSAPP_BATCH_SIZE=25
LEAD_JOB_POLL_MS=5000
```

As URLs de origem são opcionais. Sem uma delas, apenas a ação daquela fonte
retorna `LEAD_SOURCE_UNAVAILABLE`; as listas e a outra fonte continuam
acessíveis. A verificação de WhatsApp exige um canal Evolution conectado e
retorna `LEAD_EVOLUTION_NOT_CONNECTED` sem afetar buscas ou importações.

## Fluxo e limites

- Google Maps: uma busca por vez, profundidade padrão 12 (máximo configurável 20), com
  estados `queued`, `running`, `completed`, `partial` ou `failed`. Jobs Google
  falhos podem ser tentados novamente quando marcados como recuperáveis.
- Receita: pesquisa por cidade/UF, atividade/CNAE e outros filtros, consulta
  por empresa ou CNPJ e importação de CSV. CNPJ é texto e pode ser
  alfanumérico; nunca converta em número. CSV tem limite de 5 MiB. Baixe o
  relatório de linhas inválidas pelo job da própria lista.
- Empresas semelhantes: a busca usa dados da Receita e ranqueia por atividade,
  localização, perfil e prontidão comercial. O score explica os motivos, não
  garante afinidade comercial. A raiz do CNPJ de origem é excluída.
- WhatsApp: verificação **opcional** apenas para os leads selecionados, em
  lotes de até 25 números por chamada Evolution, com limites sequenciais.
  `unverified` significa desconhecido, nunca disponível. Nenhum teste de
  disponibilidade envia mensagem.
- Cadastrar contatos: cria ou reconcilia no workspace, preserva campos
  existentes, aplica a tag `Origem: Lead Google` ou `Origem: Lead Receita` e
  registra proveniência. Leads sem telefone válido são pulados e aparecem no
  resumo. A sugestão “Prospecção — Clínica padrão” é texto editável no
  Atendimento; ela só é enviada pelo clique humano em Enviar.
- Criar lote de disparo: cria campanha com status `draft`. Isso **não envia**
  mensagens. Revise destinatários, texto, canal e regras de Disparos antes de
  iniciar o envio por lá.

Toda chamada de lista, job, download, seleção e rascunho de conversa deve usar
o contexto autenticado do workspace. IDs de outro cliente resultam em não
encontrado. Não inclua credenciais da Receita, do scraper ou da Evolution no
navegador, CSV de erro ou logs de aplicação.

## Recuperação e retenção

Jobs exibem estado e erro por lista. Para `partial`, baixe o CSV de erros e
reimporte somente as linhas corrigidas; para falha Google recuperável, use
“Tentar novamente”. Chaves de idempotência evitam duplicação em reenvio de
requisições. Se a fonte estiver indisponível, verifique rede privada, carga
CNPJ/competência ou canal conectado antes de repetir.

Inclua listas, leads, jobs, proveniências, contatos e campanhas no backup do
banco operacional conforme a política do Prymeira Talk. A base pública CNPJ
pode ser reconstruída, mas retenha os arquivos brutos e backups necessários
para retomada da carga mensal. Defina retenção de listas e CSVs de erro de
acordo com a política de dados do cliente; a remoção de uma lista é uma ação
explícita, não ocorre ao concluir o job. Não trate uma campanha `draft` como
comprovante de envio.

## Verificação antes de publicar

```sh
pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/web test
pnpm -r typecheck
pnpm -r build
git diff --check
```

Faça uma busca de cada fonte em ambiente de teste, confira o isolamento entre
dois workspaces e os três perfis, importe um contato e abra o Atendimento: a
mensagem deve aparecer editável, sem novo registro de envio. Crie um lote e
confirme que ele permanece `draft` em Disparos.
