# Modelos reutilizáveis de agentes

O modelo reutilizável (`agent package`) é um arquivo JSON que descreve **como um agente deve trabalhar**, sem amarrá-lo a uma empresa específica. Ele reúne prompt, campos de qualificação, categorias de conhecimento, fontes aprovadas, regras de handoff, limites, follow-ups e ações permitidas.

Nesta primeira versão, o objetivo é transformar um agente revisado em uma base portátil para novos clientes. Importar um modelo não o coloca em produção: o Prymeira Talk sempre cria um agente **inativo**, no provedor simulado, para revisão e teste.

## Fluxo no Prymeira Talk

Na página **Agentes**, o quadro **Modelo reutilizável** permite:

1. Selecionar um arquivo `.json`.
2. Validar sua estrutura no servidor.
3. Preencher variáveis específicas da implantação, como nome do vendedor ou empresa.
4. Criar um agente inativo com suas fontes de conhecimento.
5. Testar e revisar o agente antes de qualquer ativação.
6. Exportar o agente selecionado para reutilização.

O arquivo exportado preserva os marcadores originais, como `{{seller_name}}`, e remove os valores usados na implantação atual. Dessa forma, o nome de um vendedor não é carregado por engano para outro cliente.

## O que existe dentro do modelo

| Parte | Finalidade |
| --- | --- |
| `metadata` | Identifica o modelo, empresa de origem, idioma e segmento. |
| `variables` | Define os dados que devem ser preenchidos a cada implantação. |
| `agent.systemPrompt` | Define papel, objetivo e regras de conversa. |
| `agent.qualification` | Lista o que precisa ser descoberto antes do handoff. |
| `agent.knowledgeTaxonomy` | Define as categorias e palavras que acionam cada tipo de conhecimento. |
| `agent.behavior` | Guarda regras de tom, cadência e comportamento. |
| `agent.handoff` | Define quando e com qual contexto entregar ao vendedor. |
| `agent.limits` | Limita a atuação autônoma. |
| `agent.followup` | Registra agenda comercial e sequência prevista de follow-up. |
| `agent.allowedActions` | Restringe as ações que o agente pode executar. |
| `knowledge` | Contém as fontes aprovadas e sua origem. Quando a fonte for um arquivo enviável, também carrega `fileUrl`, `fileName` e `mimeType`. |

As chaves técnicas usam letras minúsculas, números e `_`, começando por uma letra. Exemplos: `tipo_material`, `cidade_entrega` e `prazo_necessario`.

## Anexos aprovados

Uma fonte de conhecimento pode apontar para um arquivo aprovado usando `fileUrl` (com `fileName` e `mimeType` opcionais). Ao importar, a URL é persistida junto da fonte e passa a integrar a lista de anexos aprovados do agente. O runtime só entrega um `send_attachment` quando a URL enviada pelo modelo consta nessa lista; URLs não registradas são descartadas, mesmo que o modelo as invente.

O envio de anexo depende da ação `send_attachment` estar em `agent.allowedActions` e, nesta versão, funciona apenas em canais Evolution. O modelo recebe em `context.attachments` a lista de anexos aprovados (título, URL, nome e tipo) para escolher a URL correta.

## Exemplo reduzido

```json
{
  "schemaVersion": 1,
  "kind": "prymeira.agent-package",
  "metadata": {
    "key": "qualificador-comercial",
    "name": "Qualificador comercial",
    "companyName": "Empresa de referência",
    "industry": "vendas-b2b",
    "language": "pt-BR",
    "description": "Qualifica o pedido e entrega o contexto ao vendedor."
  },
  "variables": [
    {
      "key": "seller_name",
      "label": "Nome do vendedor",
      "required": true
    }
  ],
  "agent": {
    "name": "Agente de {{seller_name}}",
    "description": "Qualificação comercial antes da proposta.",
    "systemPrompt": "Qualifique o pedido e encaminhe para {{seller_name}}.",
    "qualification": {
      "completionStage": "proposal_handoff",
      "fields": [
        {
          "key": "city",
          "label": "Cidade",
          "question": "Qual é a cidade de entrega?",
          "valueType": "text",
          "requiredFor": ["proposal_handoff"],
          "acceptedInputs": ["text", "audio"],
          "dependsOn": [],
          "condition": null,
          "confirmationRequired": true
        }
      ]
    },
    "knowledgeTaxonomy": [
      {
        "key": "service_area",
        "label": "Área de atendimento",
        "aliases": ["cidade", "região"],
        "requiresSource": true
      }
    ],
    "behavior": {
      "tone": "consultivo",
      "maxQuestionsPerMessage": 1
    },
    "handoff": {
      "requiredFields": ["city"]
    },
    "limits": {
      "maxMessagesPerSession": 12
    },
    "followup": {
      "timeZone": "America/Sao_Paulo",
      "businessDays": [1, 2, 3, 4, 5],
      "businessHours": {
        "start": "08:00",
        "end": "18:00"
      },
      "steps": [],
      "closeAfterBusinessMinutes": 0
    },
    "allowedActions": [
      "send_message",
      "create_internal_note",
      "request_handoff"
    ]
  },
  "knowledge": [
    {
      "key": "service_area",
      "type": "faq",
      "title": "Área de atendimento",
      "category": "service_area",
      "content": "{{seller_name}} confirmará a disponibilidade para a região.",
      "approvalStatus": "confirmed",
      "source": "Manual comercial",
      "approvedBy": "Responsável comercial",
      "approvedAt": "2026-09-05T12:00:00.000Z",
      "validUntil": null,
      "aliases": ["região atendida"]
    }
  ]
}
```

## Conhecimento e segurança de resposta

Cada item de conhecimento registra fonte, responsável pela aprovação, data de aprovação e, quando houver, validade. O status pode ser:

- `confirmed`: informação factual aprovada, que pode fundamentar uma resposta.
- `behavioral`: padrão observado em conversas, útil para orientar abordagem, mas que não deve virar afirmação comercial sem confirmação.

Categorias com `requiresSource: true` indicam assuntos nos quais o agente só deve responder quando encontrar uma fonte adequada. A taxonomia é própria de cada modelo; ela não fica limitada a categorias genéricas nem ao setor de aço.

## Pré-validação JEV de respostas

Quando o ambiente tiver `JEV_API_KEY`, o runtime consulta o JEV antes de chamar o modelo que redige a mensagem. O JEV recebe as últimas dez mensagens, a mensagem atual e o conhecimento aprovado recuperado, e decide se existe uma resposta útil a enviar, em qual etapa está a conversa, qual caminho comercial se aplica e qual é a próxima ação.

Encerramentos sociais explícitos — por exemplo, um agradecimento sem pergunta ou pendência — encerram a execução sem chamar o modelo de chat e sem enviar mensagem. Nos demais casos, o plano é fornecido ao agente como orientação interna para a próxima resposta. O JEV não é fonte de fatos comerciais: preço, estoque, prazo, mínimo e especificações continuam dependendo de conhecimento aprovado e das regras determinísticas do runtime.

Quando o plano envolver caminho comercial, condições de encomenda, catálogo ou handoff, o runtime também envia a resposta candidata para uma auditoria JEV antes do envio. Uma resposta redundante é suprimida; uma resposta que conflita com o plano ou afirma fato comercial sem base é substituída por handoff humano. Falhas na API JEV não bloqueiam o atendimento: o runtime registra a indisponibilidade e mantém o caminho seguro existente.

Defina também `JEV_MODEL` para trocar o modelo; o padrão é `jev-latest`. Sem `JEV_API_KEY`, o caminho de geração existente é preservado.

## Regras operacionais desta versão

- A importação exige permissão de gestão de automações.
- Todas as consultas de importação e exportação respeitam o workspace autenticado.
- A importação é transacional: agente e fontes são criados juntos ou nada é salvo.
- Variáveis obrigatórias e marcadores desconhecidos impedem a importação.
- O arquivo exportado não contém os valores privados preenchidos na implantação.
- Fontes ainda em processamento ou com falha não entram no arquivo exportado.
- Importar não publica nem ativa o agente.

## API

| Método | Rota | Uso |
| --- | --- | --- |
| `POST` | `/agent-packages/validate` | Valida um arquivo sem salvar. |
| `POST` | `/agent-packages/import` | Cria o agente inativo e suas fontes no workspace atual. |
| `GET` | `/agents/:agentId/package` | Exporta o agente selecionado. |

## Limite desta entrega

Esta fundação torna a configuração portátil e permite usar taxonomias diferentes no mecanismo atual de recuperação de conhecimento. A compilação dos históricos da Villefer, versionamento/publicação, memória estruturada da negociação, processamento multimodal completo, follow-up automático após proposta e avaliação em lote são etapas seguintes construídas sobre este contrato.
