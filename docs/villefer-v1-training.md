# Treinamento do Agente Comercial Villefer V1

Esta entrega transforma os quatro históricos reconstruídos da Villefer em um primeiro pacote operacional de treinamento. O pacote foi desenhado para **qualificar o pedido e entregar o briefing ao vendedor**; ele não calcula nem envia proposta.

## Resultado da compilação

| Item | Resultado |
| --- | ---: |
| Instâncias | 4 |
| Mensagens conciliadas | 46.313 |
| Jornadas comerciais | 5.581 |
| Casos anonimizados de laboratório | 23 |
| Campos de qualificação | 15 |
| Categorias de conhecimento | 10 |
| Fontes de orientação | 9 |

Os quatro baselines contêm 1.246 identificadores de contato comercial únicos. A soma por instância é 1.309 porque alguns contatos aparecem em mais de um número. O funil executivo construído anteriormente registrou 1.248 contatos por usar outra regra de classificação; essa diferença de dois contatos deve ser reconciliada antes de reutilizar o total em uma apresentação, mas não altera os padrões usados no agente.

## Arquivos gerados

| Arquivo | Para que serve |
| --- | --- |
| `villefer-v1.agent-package.json` | Pacote que pode ser importado na página Agentes do Prymeira Talk. |
| `villefer-v1.evaluation-suite.json` | Casos anonimizados para avaliar decisões e respostas do agente. |
| `villefer-v1.evidence.json` | Agregados, contagens por instância e fingerprint dos arquivos de entrada. |
| `villefer-v1-review.md` | Checklist simples do que já foi decidido e do que a Villefer ainda precisa confirmar. |

Os arquivos ficam em `artifacts/agents/villefer/`.

## O que os históricos ensinaram

Os temas mais recorrentes foram preço/orçamento, especificação, medida/corte, entrega/frete, pagamento, nota fiscal e estoque. Eles definiram a taxonomia inicial e os cenários de teste.

Os padrões comportamentais usados na V1 são:

- pedidos podem chegar como listas incompletas distribuídas em texto, áudio, imagem e documento;
- o agente deve aproveitar tudo o que já estiver no histórico;
- uma pergunta principal por mensagem é suficiente;
- material, especificação, dimensões, quantidade, destino, modalidade e prazo formam o núcleo do briefing;
- conflito de medida, quantidade ou item precisa ser confirmado, nunca resolvido por adivinhação;
- preço não é o único bloqueio: prazo, frete, disponibilidade, completude e aprovação interna também aparecem;
- follow-up precisa investigar ou acrescentar algo; cobrança genérica não é boa cadência.

Esses itens estão marcados como `behavioral`. Eles orientam a conversa, mas não autorizam afirmações sobre a oferta atual da empresa.

## O que já está confirmado

- O agente qualifica e entrega o pedido ao vendedor.
- Cada vendedor recebe uma implantação própria do pacote em seu Talk.
- O vendedor calcula e envia a proposta.
- O agente não inventa preço, estoque, prazo, frete, pagamento ou regra fiscal.
- O horário comercial é segunda a sexta, das 8h às 18h, em São Paulo.
- A cadência prevê três follow-ups contextuais.
- Qualquer resposta ou takeover humano interrompe a cadência.
- A primeira execução deve ocorrer em laboratório, sem contato real.

## O que precisa ser validado com a Villefer

Antes de publicar, o responsável comercial deve revisar o arquivo `villefer-v1-review.md` e confirmar:

1. Catálogo, famílias, normas, qualidades e nomenclaturas.
2. Medidas padrão, tolerâncias, pesos, lotes mínimos e regras técnicas.
3. Capacidades e limitações de corte, dobra e beneficiamento.
4. Regiões, retirada, entrega, transportadoras e política de frete.
5. Fonte oficial de preço, estoque, disponibilidade e prazo.
6. Cadastro, crédito, pagamento, faturamento e questões fiscais.
7. Vendedor, departamento, tags e destino de handoff por Talk.
8. Saudação do agente e textos dos três follow-ups.
9. Critérios de ganho, perda, adiamento e encerramento sem resposta.
10. Retenção, acesso e anonimização dos dados conforme LGPD.

Sem essas confirmações, o agente pode organizar e encaminhar pedidos, mas não deve responder fatos comerciais atuais.

## Como regenerar

Os históricos brutos ficam fora do repositório do Prymeira Talk. Para recompilar o mesmo recorte:

```sh
VILLEFER_HISTORY_ROOT=/caminho/para/evolution-source-discovery/work \
pnpm --filter @prymeira-talk/api compile:villefer-v1
```

Para gravar em outro diretório:

```sh
VILLEFER_HISTORY_ROOT=/caminho/para/evolution-source-discovery/work \
VILLEFER_OUTPUT_DIR=/caminho/seguro/villefer-v1 \
pnpm --filter @prymeira-talk/api compile:villefer-v1
```

O compilador exige os pares `data/<slug>-history.json` e `analysis/<slug>-baseline.json` de Henry, Diogo, Villefer Geral e Junior Villefer. Ele não imprime mensagens no terminal.

## Como importar no Prymeira Talk

1. Abra **Agentes**.
2. No quadro **Modelo reutilizável**, selecione `villefer-v1.agent-package.json`.
3. Preencha `Nome da empresa` e `Nome do vendedor`.
4. Clique em **Importar modelo**.
5. Confirme que o agente foi criado como **Inativo**.
6. Revise prompt, tags, fontes e destino do handoff.
7. Use o **Teste do agente** antes de considerar qualquer ativação.

A importação replica a estrutura; ela não publica, ativa nem conecta o WhatsApp.

## Casos de laboratório

A suíte contém 23 cenários:

- pedido completo, pedido incompleto e lista de vários itens;
- aproveitamento de informação já fornecida;
- áudio, imagem e documento;
- informação ilegível e medida conflitante;
- preço, estoque, prazo, frete, pagamento e benefício fiscal sem fonte;
- vendedor preparando proposta;
- correção de proposta;
- três etapas de follow-up e retorno do cliente;
- compra explícita em outro fornecedor;
- takeover humano;
- documento tentando mudar as regras ou obter o prompt.

Cada caso registra estado esperado, campos capturados, campos faltantes, próxima ação, necessidade de handoff, orientação de resposta e afirmações proibidas.

Nesta fase, a suíte é o corpus de laboratório e revisão. A execução automática em lote e a comparação entre versões pertencem à etapa de versionamento e avaliação do Prymeira Talk.

## Privacidade e rastreabilidade

O compilador:

- não copia conversas para os artefatos;
- usa paráfrases nos casos de avaliação;
- bloqueia e-mail, telefone, URL, identificadores do WhatsApp, UUID e nomes encontrados nas fontes;
- registra um fingerprint SHA-256 dos inputs para rastrear qual conjunto gerou a V1;
- grava os artefatos inicialmente com permissão local restrita;
- valida o pacote contra o contrato compartilhado antes de escrever os arquivos.

Os históricos originais, anexos e segredos não devem ser adicionados ao repositório.

## Próxima decisão

O próximo encontro com a Villefer deve usar primeiro o arquivo de revisão. Depois das confirmações, as respostas factuais aprovadas podem entrar como fontes `confirmed`. Só então faz sentido avançar para execução automática da suíte, versionamento/publicação e piloto supervisionado em um número.
