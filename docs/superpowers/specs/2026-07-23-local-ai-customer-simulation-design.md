# Simulação local de cliente com agente de IA

## Contexto

O ambiente de demonstração do Prymeira Talk já possui conversas, contatos, tags, notas internas, agentes e um provedor de IA simulado. O runtime do agente também já consegue responder mensagens, aplicar tags permitidas, criar notas internas e solicitar atendimento humano.

O que falta para a apresentação é um fluxo visível e controlado dentro da caixa de entrada: o apresentador deve conseguir escrever uma mensagem como se fosse o cliente e acompanhar a IA reagindo na conversa real da demonstração.

## Decisões aprovadas

1. A simulação acontecerá na conversa selecionada da caixa de entrada.
2. O apresentador poderá alternar o compositor para o modo `Simular cliente`.
3. A mensagem será persistida como uma mensagem recebida do contato.
4. O agente responderá automaticamente e poderá aplicar tags, criar nota interna ou solicitar atendimento humano.
5. Todo o fluxo funcionará no localhost, sem depender de internet, chave de IA ou WhatsApp conectado.
6. A funcionalidade ficará disponível somente no ambiente de demonstração local.
7. O envio normal do atendente continuará funcionando sem mudanças quando o modo de simulação estiver desligado.
8. O reset da demonstração continuará restaurando o cenário inicial.

## Objetivo

Criar uma demonstração curta, confiável e visualmente convincente do fluxo:

1. Cliente envia uma mensagem.
2. Prymeira Talk recebe e exibe a mensagem em tempo real.
3. O agente analisa o conteúdo.
4. A IA responde na conversa.
5. A IA organiza o atendimento com tag, nota ou handoff.

O fluxo deve parecer real para o cliente, mas permanecer determinístico o suficiente para uma apresentação ao vivo.

## Experiência na caixa de entrada

### Entrada no modo de simulação

Quando a demonstração local estiver habilitada, a conversa selecionada exibirá a ação `Simular cliente`.

Ao ativar essa ação:

- o compositor muda de aparência;
- um aviso informa `Você está simulando uma mensagem de <nome do contato>`;
- o placeholder passa a orientar que a mensagem será recebida como cliente;
- o botão de envio passa a usar o texto ou rótulo acessível `Enviar como cliente`;
- permanece disponível uma ação clara para voltar ao modo atendente.

Essa diferenciação deve impedir que o apresentador confunda uma mensagem inbound simulada com uma resposta humana outbound.

### Execução visível

Após o envio:

1. A mensagem aparece no lado do cliente.
2. A conversa é atualizada e marcada como ativa/não lida conforme as regras existentes.
3. O agente comercial local é ativado ou retomado para aquela conversa.
4. A interface mostra por um intervalo curto o estado `Assistente Comercial IA está analisando…`.
5. A resposta da IA aparece no lado do atendimento.
6. Tags e demais efeitos aparecem sem recarregar a página.

O atraso visual deve ser curto, aproximadamente entre um e dois segundos. Ele existe para tornar a automação compreensível, não para simular lentidão externa.

## Comportamento controlado do agente

O provedor simulado deve interpretar texto livre por intenções previsíveis. O apresentador não ficará limitado a botões com frases prontas.

### Orçamento ou intenção de compra

Exemplos:

- `Preciso de orçamento urgente para 120 unidades.`
- `Quero uma proposta para equipar uma nova unidade.`
- `Quanto custa e vocês entregam ainda este mês?`

Resultado:

- resposta comercial consultiva;
- aplicação da tag `Orçamento quente`;
- criação de uma nota interna resumindo a intenção e os dados disponíveis;
- continuidade com a IA, salvo quando a própria mensagem pedir uma pessoa.

### Suporte, atraso ou insatisfação

Exemplos:

- `Meu pedido está atrasado.`
- `Estou irritado porque ninguém me respondeu.`
- `Preciso falar com alguém do suporte.`

Resultado:

- resposta acolhedora;
- aplicação da tag `Suporte`;
- criação de uma nota interna com o motivo;
- solicitação de handoff quando houver irritação, pedido explícito por humano ou baixa confiança.

### Dúvida comercial comum

Exemplos:

- `Qual é o prazo de entrega?`
- `Vocês atendem empresas de Santa Catarina?`

Resultado:

- resposta baseada no conhecimento local já cadastrado;
- nenhuma tag obrigatória quando não houver sinal comercial forte;
- sessão do agente permanece ativa.

### Mensagem genérica

Para mensagens fora dos cenários reconhecidos, o agente deve responder de forma neutra e pedir contexto adicional. Ele não deve inventar dados, tags ou condições comerciais.

## Tags e permissões

O agente de demonstração terá acesso somente às tags necessárias para os cenários aprovados:

- `Orçamento quente`;
- `Suporte`;
- opcionalmente `Follow-up` quando o texto indicar retorno posterior.

As tags continuam sendo validadas pelo executor de ações existente. O provedor simulado não poderá criar tags novas nem contornar as permissões do agente.

## Notas internas

Quando houver informação operacional útil, o agente criará uma nota interna curta, por exemplo:

`IA identificou pedido de orçamento para 120 unidades com urgência. Confirmar prazo e condição de pagamento.`

A nota deve ser persistida pelo fluxo normal já existente e identificada como ação do agente para fins de auditoria.

## Arquitetura

### API de demonstração

Será criado ou estendido um endpoint exclusivo da demonstração para receber:

- identificador da conversa selecionada;
- corpo da mensagem do cliente.

O endpoint deve:

1. validar autenticação, workspace, modo local e conversa;
2. persistir a mensagem inbound;
3. atualizar o resumo e o contador da conversa;
4. garantir uma sessão ativa do agente de demonstração;
5. disparar o runtime real do agente usando o provedor simulado;
6. publicar os eventos realtime necessários;
7. retornar uma confirmação curta sem duplicar dados já entregues por realtime.

O fluxo deverá reutilizar o runtime, o executor de ações e as validações existentes, em vez de gravar diretamente uma resposta, tag ou nota pré-fabricada.

### Provedor simulado

O provedor local será ampliado com um classificador determinístico de intenções e respostas específicas para a demonstração. A saída continuará usando o contrato estruturado atual:

- `reply`;
- `confidence`;
- `actions`;
- `handoff`.

Isso preserva o mesmo caminho que um provedor de IA real utilizaria futuramente, trocando apenas a origem da decisão.

### Interface

A caixa de entrada chamará a API de demonstração somente quando o modo `Simular cliente` estiver ativo. O envio outbound já existente não será reutilizado com direção invertida.

O estado visual de análise deve ser derivado do ciclo da requisição e/ou dos eventos do runtime. Falhas devem encerrar o indicador e manter a mensagem digitada disponível para nova tentativa quando ela ainda não tiver sido persistida.

## Persistência e reset

Mensagens, sessões, execuções, tags e notas criadas durante o teste permanecerão no banco local para permitir que o apresentador navegue entre módulos e mostre o resultado.

O reset integrado da demonstração deve remover essas alterações e recriar exatamente o cenário inicial validado.

## Segurança e isolamento

- O endpoint não será habilitado fora do modo local de demonstração.
- Toda conversa deverá pertencer ao workspace autenticado.
- O corpo será limitado e validado.
- O agente usado deverá ser o agente oficial da demonstração.
- Nenhuma chamada será enviada a contatos reais ou provedores externos.
- Nenhuma chave secreta será necessária no navegador.

## Estados de erro

- Sem conversa selecionada: a ação fica indisponível.
- Mensagem vazia: o envio fica bloqueado.
- Conversa inexistente ou de outro workspace: erro sem persistência.
- Agente ausente ou inativo: mensagem clara de que o cenário precisa ser resetado.
- Falha do agente após persistir o inbound: a mensagem permanece na conversa e a interface informa que a resposta automática falhou.
- Handoff solicitado: a conversa muda para o estado já suportado de atenção humana.

## Testes

### Backend

- validação e isolamento do endpoint de demonstração;
- persistência da mensagem inbound;
- ativação ou retomada da sessão do agente;
- resposta comercial com `Orçamento quente` e nota interna;
- suporte/irritação com tag e handoff;
- mensagem genérica sem tag inventada;
- publicação dos eventos realtime;
- rejeição fora do modo local;
- reset remove todos os efeitos do teste.

### Frontend

- ação aparece somente no modo de demonstração;
- alternância entre atendente e cliente é clara;
- envio normal permanece outbound;
- envio simulado é encaminhado para a API correta;
- indicador de análise aparece e encerra;
- mensagens e tags atualizam sem reload;
- falhas liberam o compositor e mostram feedback.

### Verificação manual

1. Abrir o atendimento no localhost.
2. Selecionar um contato.
3. Ativar `Simular cliente`.
4. Enviar `Preciso de orçamento urgente para 120 unidades`.
5. Confirmar inbound, estado de análise, resposta, tag e nota.
6. Enviar um cenário de insatisfação em outra conversa.
7. Confirmar tag de suporte e handoff.
8. Voltar ao modo atendente e enviar uma resposta normal.
9. Resetar a demonstração e confirmar o estado inicial.

## Fora de escopo

- conectar um WhatsApp real para a simulação;
- usar um provedor de IA externo durante a apresentação;
- permitir simulação fora do ambiente local;
- criar tags dinamicamente;
- alterar o comportamento dos agentes de produção;
- sincronizar cada mensagem da conversa com o CRM;
- transformar o simulador em um construtor genérico de cenários.

## Critérios de sucesso

1. O apresentador consegue digitar livremente como cliente dentro da conversa selecionada.
2. A mensagem aparece como inbound persistido.
3. O agente responde automaticamente em até poucos segundos.
4. Um pedido de orçamento aplica `Orçamento quente` e cria uma nota útil.
5. Uma insatisfação aplica `Suporte` e solicita atendimento humano.
6. Todo o fluxo funciona sem internet e sem credenciais externas.
7. O envio normal do atendente continua funcionando.
8. O reset restaura o cenário original.
