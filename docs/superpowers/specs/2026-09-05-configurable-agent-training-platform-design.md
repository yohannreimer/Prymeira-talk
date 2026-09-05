# Plataforma Configurável de Treinamento e Operação de Agentes

## Contexto

O Prymeira Talk já possui uma base funcional para agentes autônomos:

- configuração de agente e prompt do sistema;
- fontes de conhecimento do tipo FAQ, texto, PDF e TXT;
- histórico recente da conversa;
- recuperação determinística de documentos;
- resposta estruturada por provedor compatível com OpenAI;
- ações controladas, tags, notas internas e handoff;
- chat de teste e registros de execução;
- bloqueio da IA quando um humano assume a conversa.

O primeiro caso real será o atendimento comercial da Villefer. Foram reconstruídas conversas de quatro números de WhatsApp, totalizando 46.313 mensagens e 1.248 contatos comerciais únicos no período analisado. Esse material é suficiente para construir uma primeira versão operacional de qualificação, handoff e acompanhamento de propostas.

A Villefer, porém, não deve ser codificada diretamente no produto. O Prymeira Talk precisa funcionar como uma plataforma genérica capaz de receber configurações, conhecimentos e processos de empresas de segmentos diferentes.

## Decisão principal

Separar o sistema em duas camadas:

1. **Motor genérico do Prymeira Talk**
   - interpreta mensagens e anexos;
   - administra memória, etapas, qualificação, handoff e follow-up;
   - executa ações permitidas;
   - testa, versiona, publica e audita agentes;
   - não contém regras específicas de aço, clínicas, imóveis ou qualquer outro segmento.

2. **Pacote configurável da empresa**
   - define identidade, objetivo, campos, perguntas, conhecimento, limites, cadências e testes;
   - é versionado e implantado em um ou mais Talks;
   - nunca inclui dados pessoais provenientes dos históricos usados na sua criação.

O primeiro pacote concreto será o **Agente Comercial Villefer V1**. Outros clientes poderão usar o mesmo motor com pacotes completamente diferentes.

## Objetivos

- Transformar históricos comerciais em prompt, conhecimento, playbook e casos de teste revisáveis.
- Permitir a criação de agentes para diferentes tipos de empresa sem alteração de código.
- Qualificar novos leads usando texto, áudio, imagem e documentos.
- Entregar ao vendedor um resumo estruturado suficiente para preparar uma proposta.
- Detectar o envio de proposta de modo híbrido: automaticamente, com correção manual.
- Retomar o atendimento para follow-up contextualizado depois que o vendedor envia a proposta.
- Preservar o controle humano e bloquear imediatamente a IA quando um vendedor assume.
- Publicar somente versões avaliadas, auditáveis e reversíveis.
- Medir o desempenho do agente contra o atendimento histórico e contra versões anteriores.

## Não objetivos da primeira versão

- Calcular ou emitir propostas comerciais.
- Definir preço, desconto, estoque, frete ou prazo confirmado.
- Negociar condições comerciais sem intervenção humana.
- Fazer fine-tuning de modelo com todas as conversas brutas.
- Transformar respostas históricas em fatos sem validação.
- Construir orquestração complexa de múltiplos agentes.
- Permitir que conteúdo enviado pelo cliente altere regras do sistema.

## Arquitetura de treinamento

O treinamento será uma linha de produção separada da operação ao vivo:

```text
Conversas históricas
        -> anonimização e reconstrução
        -> extração de padrões e conhecimento candidato
        -> classificação por tipo e confiança
        -> revisão e aprovação humana
        -> pacote versionado da empresa
        -> avaliação com casos históricos
        -> publicação nos Talks
        -> operação monitorada e melhoria contínua
```

Os históricos são matéria-prima, não fonte automática de verdade. Cada item extraído recebe um estado:

- `confirmed`: aprovado e utilizável pelo agente;
- `needs_validation`: recorrente nos históricos, mas ainda depende de confirmação;
- `behavioral`: ensina como conduzir a conversa, sem afirmar fato comercial;
- `discarded`: desatualizado, contraditório, inseguro ou inadequado.

Somente conteúdo `confirmed` pode fundamentar uma afirmação comercial. Conteúdo `behavioral` pode orientar tom, sequência de perguntas e tratamento de objeções. Os demais estados não entram na resposta em produção.

## Componentes do pacote da empresa

Cada pacote publicado possui seis componentes independentes.

### 1. Prompt principal

Define:

- identidade e missão;
- objetivo da conversa;
- estilo e tamanho das mensagens;
- limites de autonomia;
- processo de qualificação;
- tratamento de informações incertas;
- regras de handoff;
- comportamento depois da proposta;
- formato da resposta e do resumo interno.

O prompt não deve armazenar preços, catálogo ou políticas extensas. Esses fatos ficam nas fontes de conhecimento.

### 2. Conhecimento validado

Contém fatos aprovados sobre a empresa, como:

- produtos e serviços;
- especificações e glossário;
- regiões e modalidades de atendimento;
- políticas comerciais;
- orientações operacionais;
- perguntas frequentes.

Cada fonte registra empresa, origem, aprovador, data de aprovação, validade opcional e versão de publicação.

### 3. Esquema de qualificação

Define campos configuráveis, perguntas, dependências e critérios de conclusão. Um campo pode declarar:

```json
{
  "key": "espessura",
  "label": "Espessura",
  "question": "Qual espessura você precisa?",
  "requiredFor": ["proposal_handoff"],
  "acceptedInputs": ["text", "image", "document"],
  "dependsOn": ["product"],
  "condition": "selected product requires thickness",
  "confirmationRequired": true
}
```

O motor interpreta esse esquema de forma genérica. Nenhum nome de campo específico da Villefer deve aparecer em regras fixas do runtime.

### 4. Playbook de atendimento

Define como:

- abrir e contextualizar a conversa;
- aproveitar informações já fornecidas;
- perguntar apenas o próximo dado necessário;
- confirmar o entendimento;
- reagir a dúvidas e objeções;
- preparar o handoff;
- acompanhar a proposta;
- encerrar sem declarar uma venda perdida sem evidência.

### 5. Exemplos de conversa

São trechos anonimizados e revisados que demonstram comportamento desejado e indesejado. Eles orientam a condução da conversa, mas não substituem fontes de conhecimento atuais.

### 6. Conjunto de avaliação

Reúne casos históricos anonimizados com contexto, entrada, estado esperado, próxima ação, resposta aceitável, handoff esperado e afirmações proibidas.

## Pacote Villefer V1

### Missão

Qualificar completamente o pedido, confirmar o entendimento e entregar o contexto ao vendedor. O vendedor prepara e envia a proposta. Depois do envio, o agente retoma o acompanhamento conforme a cadência configurada.

### Checklist inicial de qualificação

O checklist é uma hipótese inicial derivada dos históricos e deve ser validado com a empresa antes da publicação:

- nome e empresa, quando aplicável;
- cidade ou local de entrega;
- produto ou tipo de material;
- aplicação desejada;
- especificação ou qualidade;
- espessura;
- largura e comprimento;
- quantidade, peso ou número de peças;
- corte, dobra ou outro beneficiamento;
- entrega ou retirada;
- prazo desejado;
- anexos relevantes;
- dúvidas e informações ainda pendentes.

O agente não apresenta um formulário de uma vez. Ele aproveita tudo o que já foi informado e pergunta somente o próximo dado necessário.

### Handoff para proposta

Antes do handoff, o agente:

1. confirma com o cliente o entendimento do pedido;
2. registra os dados confirmados;
3. explicita os dados ainda pendentes;
4. cria uma nota interna resumida;
5. direciona a conversa ao vendedor responsável pelo Talk atual;
6. pausa sua atuação até a proposta ser enviada ou o vendedor liberar a conversa.

### Limites comerciais

O agente não pode:

- criar ou modificar preços;
- conceder desconto;
- garantir disponibilidade;
- prometer prazo ou frete;
- alterar condição de pagamento;
- modificar uma proposta;
- declarar ganho ou perda sem evidência;
- continuar respondendo com o humano no controle.

Depois da proposta, o agente pode esclarecer informações presentes em fontes aprovadas, identificar objeções, perguntar o que precisa ser ajustado e chamar o vendedor. Desconto, valor, estoque, prazo confirmado, condição especial e alterações na proposta exigem handoff.

### Detecção de proposta

O sistema usa detecção híbrida:

- sinal automático a partir de PDF, documento ou mensagem outbound compatível com proposta;
- confirmação ou correção manual pelo vendedor;
- registro de quem marcou ou corrigiu a etapa;
- início da cadência somente depois de uma proposta confirmada.

### Cadência inicial

- primeiro follow-up após 12 horas úteis desde a proposta confirmada, se não houver resposta;
- segundo follow-up ao completar dois dias úteis desde a proposta confirmada;
- terceiro follow-up ao completar quatro dias úteis desde a proposta confirmada;
- registro como `no_response` ao completar sete dias úteis desde a proposta confirmada sem retorno, sem classificar automaticamente como perda;
- envio somente de segunda a sexta, das 8h às 18h;
- interrupção imediata quando cliente ou vendedor responder;
- mensagens contextualizadas pelo pedido e pela proposta;
- nenhuma campanha genérica deve contar como follow-up da negociação.

A cadência é configuração do pacote, não regra fixa do motor.

## Processamento multimodal

O motor normaliza todas as entradas antes do raciocínio comercial:

- texto permanece texto;
- áudio é transcrito e preserva referência ao arquivo original;
- imagem é descrita e tem textos visíveis extraídos;
- PDF e documento têm seus conteúdos e itens extraídos;
- múltiplos anexos podem compor um único pedido.

O resultado de cada processamento é armazenado uma vez e reutilizado. O mesmo anexo não deve ser reenviado ao modelo em todas as respostas.

Se a informação estiver ilegível, incompleta ou ambígua, o agente pede confirmação. Arquivos técnicos complexos ou conflitantes geram handoff.

## Memória estruturada da negociação

Além do histórico textual, cada conversa mantém um estado estruturado derivado do esquema do pacote:

```json
{
  "stage": "qualification",
  "fields": {
    "product": { "value": "chapa de aço", "status": "confirmed" },
    "thickness": { "value": "3 mm", "status": "confirmed" },
    "specification": { "value": null, "status": "missing" }
  },
  "missingFields": ["specification"],
  "proposalStatus": "not_sent",
  "followupStep": 0,
  "humanControl": false
}
```

O estado precisa distinguir valores detectados, confirmados, conflitantes e ausentes. A IA não pode transformar automaticamente um valor inferido em valor confirmado.

## Configurador de agentes

O módulo Agentes será organizado em etapas:

1. empresa e objetivo;
2. processo e critérios de avanço;
3. campos de qualificação e condições;
4. conhecimento e taxonomia própria;
5. comportamento e proibições;
6. handoff, horário e acompanhamento;
7. testes, comparação e publicação.

O usuário deve conseguir definir campos e categorias sem programação. As categorias atuais, codificadas como `precos`, `produto`, `faq`, `politicas`, `onboarding`, `comercial`, `suporte` e `outro`, deixam de ser uma enumeração fechada para o runtime. O produto pode oferecer sugestões iniciais, mas cada agente possui sua própria taxonomia e aliases de recuperação.

## Versionamento e implantação

Cada agente possui:

- um registro lógico editável;
- uma versão de rascunho usada apenas em testes;
- uma versão publicada imutável;
- histórico de versões;
- ação de rollback.

Uma versão publicada congela:

- prompt;
- esquema de qualificação;
- processo e cadência;
- limites e ações permitidas;
- fontes e revisões de conhecimento;
- conjunto mínimo de testes;
- variáveis de implantação.

O Pacote Mestre Villefer será replicado nos Talks individuais. Variáveis locais incluem nome do vendedor, canal, horário, destino de handoff, departamento e tags permitidas. Melhorias são feitas no pacote mestre, testadas e distribuídas como uma nova versão. Não há sincronização silenciosa de rascunhos.

## Modelo conceitual de dados

O desenho deve evoluir os modelos existentes sem misturar responsabilidades:

- `AiAgent`: identidade lógica do agente no workspace;
- `AiAgentVersion`: snapshot imutável de prompt, processo, esquema, cadência, limites e manifesto de fontes;
- `AiKnowledgeSource`: fonte lógica e seus metadados de aprovação;
- `AiKnowledgeRevision`: conteúdo versionado utilizado por uma versão do agente;
- `AiAgentEvaluationSuite`: conjunto de casos de avaliação;
- `AiAgentEvaluationRun`: resultado comparável por versão;
- `AiConversationState`: memória estruturada segundo o esquema publicado;
- `AiMediaExtraction`: transcrição ou extração reutilizável de uma mensagem/anexo;
- `AiAgentDeployment`: vínculo entre versão publicada e configuração local do Talk.

Os nomes finais podem seguir as convenções Prisma existentes, mas essas fronteiras devem permanecer: identidade, versão, conhecimento, avaliação, memória, mídia e implantação são unidades separadas.

## Compatibilidade com a base atual

- `AiAgent.systemPrompt` passa a alimentar o rascunho e permanece compatível durante a migração.
- `behaviorConfig`, `handoffConfig` e `limitsConfig` podem ser migrados para o snapshot versionado.
- `AiKnowledgeSource` continua representando FAQ, texto ou arquivo, mas ganha revisões e metadados de aprovação.
- `conversation-context-builder` continua fornecendo o histórico, enquanto a memória estruturada é adicionada como contexto distinto.
- `knowledge-retrieval` deixa de depender apenas de categorias fixas e passa a usar a taxonomia publicada do agente.
- `agent-runtime` recebe somente uma versão publicada em operação.
- `agent-test-chat` pode executar o rascunho e mostrar estado, fontes, extrações e decisões.
- `AiAgentRun` registra a versão usada, o estado anterior e posterior, as fontes, o uso de mídia e o motivo das ações.

## Avaliação

Cada caso de teste contém:

- contexto de conversa;
- mensagem ou anexo do cliente;
- informações esperadas;
- informações ainda faltantes;
- próxima ação esperada;
- resposta aceitável;
- handoff esperado;
- afirmações proibidas.

Os critérios incluem:

- entendimento do pedido;
- uso correto de dados já fornecidos;
- ausência de perguntas repetidas;
- escolha do próximo dado necessário;
- precisão da extração multimodal;
- completude do resumo;
- handoff correto;
- cumprimento da cadência;
- naturalidade para WhatsApp;
- ausência de invenção comercial.

Falhas eliminatórias:

- inventar preço, prazo, estoque ou condição;
- confundir clientes ou propostas;
- ignorar controle humano;
- enviar follow-up após resposta;
- expor informações de outra empresa;
- obedecer a instruções maliciosas presentes em mensagem ou documento.

A primeira versão somente pode ser publicada se atingir os critérios mínimos definidos pelo pacote e não tiver falhas eliminatórias. Versões posteriores também precisam igualar ou superar a versão publicada nos critérios comparáveis.

## Liberação gradual

1. **Laboratório:** casos históricos, sem contato real.
2. **Modo sombra:** analisa conversas reais e sugere, mas não envia.
3. **Piloto supervisionado:** envia em um Talk com acompanhamento humano.
4. **Produção gradual:** versão aprovada é distribuída aos demais Talks.

O piloto começa em um número. A ampliação depende dos resultados, não apenas de prazo decorrido.

## Métricas

- tempo até a primeira resposta útil;
- percentual de leads completamente qualificados;
- perguntas repetidas;
- tempo entre qualificação e proposta;
- percentual de propostas acompanhadas;
- retorno após cada follow-up;
- handoffs corretos e incorretos;
- intervenções dos vendedores;
- conversas abandonadas antes da proposta;
- falhas de mídia e conhecimento;
- comparação entre versões do agente.

## Segurança e privacidade

- isolamento por workspace em todos os registros e consultas;
- históricos anonimizados para treinamento e avaliação;
- nenhuma informação pessoal no pacote reutilizável;
- documentos e mensagens tratados como dados não confiáveis, nunca como instruções do sistema;
- fontes restritas à empresa e à versão correta;
- segredos de provedores mantidos fora de prompts, logs e respostas;
- ações validadas contra permissões antes da execução;
- bloqueio de execução enquanto `human_controlled`;
- trilha de auditoria para edição, aprovação, publicação, rollback e execução;
- política de retenção e exclusão compatível com a operação e a LGPD.

## Tratamento de falhas

- áudio ilegível: solicitar repetição ou texto;
- imagem insuficiente: pedir nova foto ou confirmação;
- documento corrompido ou complexo: handoff;
- informação conflitante: manter conflito explícito e fazer handoff;
- provedor indisponível: não duplicar respostas e registrar falha;
- saída estruturada inválida: não enviar resposta autônoma;
- falha de follow-up: aplicar somente tentativas limitadas e auditáveis;
- ausência de conhecimento obrigatório: handoff seguro;
- takeover humano: cancelar execução e agendamentos pendentes.

## Critérios de sucesso da Villefer V1

A V1 é funcional quando consegue, em piloto supervisionado:

1. receber texto, áudio, imagem e documento;
2. organizar corretamente os itens de um pedido;
3. aproveitar informações já presentes na conversa;
4. pedir apenas os dados relevantes ainda ausentes;
5. confirmar o entendimento;
6. produzir resumo estruturado para o vendedor;
7. pausar durante a elaboração da proposta;
8. reconhecer ou receber confirmação de proposta enviada;
9. executar a cadência aprovada;
10. interromper a automação em resposta ou takeover;
11. registrar objeções e motivos observáveis;
12. não cometer nenhuma falha eliminatória nos testes de publicação.

## Sequência recomendada

1. Criar o formato genérico do pacote e do esquema de qualificação.
2. Transformar os históricos da Villefer em conhecimento candidato, playbook e testes.
3. Revisar o material com o responsável da empresa.
4. Implementar versionamento, avaliação e publicação no Prymeira Talk.
5. Implementar processamento multimodal e memória estruturada.
6. Implementar detecção híbrida de proposta e cadência genérica.
7. Executar laboratório, modo sombra e piloto em um Talk.
8. Ajustar e distribuir a versão aprovada aos demais Talks.

## Decisões aprovadas

- um pacote mestre da Villefer, distribuído aos Talks individuais;
- motor genérico para atender empresas de outros segmentos;
- qualificação completa antes da proposta;
- proposta preparada e enviada pelo vendedor;
- interpretação de texto, áudio, imagem e documentos;
- detecção híbrida de proposta;
- retomada automática para acompanhamento;
- três follow-ups dentro do horário comercial;
- dúvidas simples respondidas com conhecimento aprovado;
- renegociação, exceções e condições comerciais sempre encaminhadas ao vendedor;
- publicação gradual com avaliação e rollback.
