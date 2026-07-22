# Carteira Vincula originada no Talk — desenho da demonstração

## Objetivo

Fazer o Vincula local parecer uma continuação já utilizada do Prymeira Talk. A carteira inicial do CRM deve conter somente pessoas que também existem no Talk, com vínculos reais entre os dois bancos. Carlos Mendes permanece exclusivamente no Talk até ser sincronizado ao vivo durante a apresentação.

## História da demonstração

1. O apresentador abre **Contatos** no Vincula e reconhece nove pessoas já presentes no Talk.
2. Abre **Negócios** e mostra seis oportunidades históricas distribuídas pelo Kanban.
3. Volta ao Talk, simula ou abre Carlos Mendes e acessa **Vincula CRM**.
4. Cria a oportunidade de Carlos.
5. O Talk cria ou reutiliza empresa, contato e negócio no Vincula, passando a carteira de nove para dez contatos.
6. **Abrir no Vincula** leva diretamente à nova ficha sobre o Kanban.
7. **Enviar nota da IA** acrescenta uma nota ao mesmo negócio, sem duplicar registros.
8. **Restaurar** devolve os dois produtos ao cenário inicial.

## Carteira compartilhada

O Talk continua com dez contatos. Os nove abaixo existem também no Vincula desde o reset, com os mesmos nomes, telefones, e-mails e empresas:

| Pessoa | Empresa | Estado inicial no Vincula |
| --- | --- | --- |
| Ana Beatriz | Clínica Aurora | Contato e negócio |
| João Martins | JM Auto Peças | Somente contato |
| Camila Rocha | Studio Rocha | Contato e negócio |
| Pedro Almeida | Almeida Energia | Somente contato |
| Larissa Gomes | Gomes Moda | Contato e negócio |
| Marcelo Souza | Souza Manutenção | Contato e negócio |
| Renata Vieira | Vieira Engenharia | Contato e negócio |
| Bruno Tavares | Tavares Obras | Contato e negócio |
| Paula Freitas | Freitas Logística | Somente contato |

Carlos Mendes, da Construtora Horizonte, não existe inicialmente no Vincula. Depois da sincronização, ele se torna o décimo contato e a Construtora Horizonte a décima empresa.

## Kanban inicial

Os seis negócios históricos usam o Pipeline comercial e responsáveis da equipe local:

| ID | Etapa | Contato | Valor | Probabilidade | Responsável | Narrativa da nota |
| --- | --- | --- | ---: | ---: | --- | --- |
| 9501 | Oportunidade | Marcelo Souza | R$ 24.000 | 35% | Fernanda Lima | Região e prazo de entrega em qualificação |
| 9502 | Proposta enviada | Ana Beatriz | R$ 68.000 | 60% | Marina Costa | Proposta preparada para equipar a nova unidade |
| 9503 | Proposta enviada | Larissa Gomes | R$ 32.000 | 55% | Lucas Ribeiro | Condição recorrente enviada e aguardando retorno |
| 9504 | Em negociação | Camila Rocha | R$ 92.000 | 80% | Bia Almeida | Condições por volume e agenda comercial em negociação |
| 9505 | Ganho | Renata Vieira | R$ 54.000 | 100% | Marina Costa | Fornecimento aprovado e concluído |
| 9506 | Perdido | Bruno Tavares | R$ 38.000 | 0% | Lucas Ribeiro | Projeto pausado após validação financeira |

Todos os seis usam origem **Prymeira Talk**. Os cartões ocupam todas as colunas do Kanban antes da demonstração. Carlos entra em **Oportunidade**, com origem **Prymeira Talk**, probabilidade de 75% e o próximo ID disponível.

## Vínculo entre os bancos

O seed do Vincula usa empresas `9301` a `9309`, contatos `9401` a `9409`, negócios `9501` a `9506` e notas `9601` a `9606`. A ordem dos IDs acompanha a ordem da tabela de carteira compartilhada. O seed do Talk grava esses IDs nos campos `atomicCrmContactId` e, quando houver negócio, `atomicCrmLeadId`.

O Talk também recebe ações históricas `real/completed` para os contatos que já possuem negócio. Essas ações incluem `environment: local-demo`, IDs reais e `vinculaRecordUrl` com rota `/#/deals/{id}/show`. Assim, selecionar um contato previamente sincronizado no módulo Vincula CRM mostra histórico verdadeiro e permite abrir sua ficha.

Os três contatos sem negócio possuem somente `atomicCrmContactId`. Se o apresentador criar uma oportunidade para um deles, o serviço deve reutilizar empresa e contato e criar apenas o negócio e a nota inicial.

## Reset determinístico

O reset coordenado mantém a ordem existente:

1. Vincula restaura nove empresas, nove contatos e seis negócios.
2. Talk restaura dez contatos e referencia os IDs fixos criados na primeira etapa.

Carlos volta a ficar sem `atomicCrmContactId`, sem `atomicCrmLeadId` e sem ação de sincronização. Os contadores retornados pelo Vincula passam a informar nove empresas, nove contatos, seis negócios e a quantidade correspondente de notas.

Falhas mantêm o comportamento atual: se o Vincula não restaurar, o Talk permanece inalterado; se o Talk falhar depois do Vincula, a API informa reset parcial.

## Escopo de implementação

- Substituir a carteira neutra do seed local do Vincula pela carteira originada no Talk.
- Adicionar os seis negócios e notas definidos neste documento.
- Atualizar os contadores e testes do reset do Vincula.
- Gravar no seed do Talk os IDs reais dos nove contatos e dos seis negócios.
- Substituir ações simuladas antigas por histórico local real e coerente.
- Preservar Carlos como caso não sincronizado.
- Atualizar testes do reset coordenado, do serviço CRM e da interface quando necessário.
- Atualizar o roteiro da demonstração com a passagem Contatos existentes → Carlos novo.

Não fazem parte deste escopo mudanças no layout do Vincula, criação de um sincronizador geral, importação automática de todos os contatos fora da demo ou integração com ambientes externos.

## Critérios de aceitação

- Após `pnpm demo:reset:all`, o Talk possui dez contatos e o Vincula possui exatamente nove contatos, todos originados no Talk.
- Nenhum dos quatro contatos ou empresas neutros anteriores permanece no Vincula.
- O Kanban contém seis negócios distribuídos nas cinco etapas definidas.
- Os nove contatos compartilhados têm telefone, e-mail e empresa equivalentes nos dois bancos.
- O Talk armazena `atomicCrmContactId` para os nove contatos e `atomicCrmLeadId` para os seis com negócio.
- Carlos não possui vínculo ou histórico inicial no Talk e não aparece no Vincula.
- Sincronizar Carlos cria somente uma empresa, um contato, um negócio e as notas esperadas.
- Carlos passa a ser o décimo contato; repetir a sincronização não cria duplicatas.
- **Abrir no Vincula** abre a ficha nativa do negócio de Carlos.
- Enviar a nota da IA adiciona a nota ao negócio existente.
- Restaurar pela interface remove Carlos do Vincula e volta aos nove contatos e seis negócios.
- Testes, typechecks, builds e `pnpm demo:check` terminam com sucesso, mantendo bancos e artefatos no SSD.
