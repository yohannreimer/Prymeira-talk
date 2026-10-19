# Follow-ups contextuais compartilhados

Data: 19/10/2026. Estado: proposta para implementação; nenhuma ativação autorizada por este documento.

## Problema e evidência

Base examinada: `1d7aa19ed9c4a48532937408b9ece782c53d5cd6`, branch de produção `codex/audit-stabilization-20261015`. A branch padrão do GitHub é diferente e não deve ser usada como base desta mudança. Os hashes dos módulos de geração e dos adaptadores comercial/atendimento foram comparados com a API em produção durante o diagnóstico.

O caminho legado transforma qualquer etapa `qualification` na instrução técnica de `followup-step-instruction.ts`, substituindo a instrução configurada. Um caso comercial cuja pendência era escolher um horário voltou com `reply: null` e foi colocado em revisão sem rascunho. Uma reprodução sem persistência ou transporte confirmou a resposta vazia; uma instrução contextual produziu uma pergunta sobre os horários. Isso demonstra a falha nesse caso, não a qualidade de uma migração inteira.

O sistema tem três caminhos de geração: legado com elegibilidade/JEV/escritor; `brain`, ativado por workspace e marcador da decisão; e o analista do harness de atendimento, ligado por agente/canal. A seleção do harness no follow-up reconhece apenas `agente: atendimento`. A Maria dos anúncios usa `agente: comercial` nas respostas, mas isso não a integra ao analista de follow-ups. O João, de prospecção, é explicitamente excluído do harness quando há reserva de campanha.

A [PR #53](https://github.com/yohannreimer/Prymeira-talk/pull/53) introduziu o comercial para entrada direta e preservou deliberadamente a Maria do site e sessões existentes. Portanto, o objetivo aqui é integrar o acompanhamento, sem migrar junto os motores que respondem às mensagens recebidas.

## Objetivo

Um processo comum lê a conversa, identifica a pendência e seu responsável, escolhe uma ação por código, escreve e revisa o texto. Cada perfil fornece suas regras e fontes. O ciclo existente continua dono de agendamento, claims, aprovação, envio, confirmação e próxima etapa.

Perfis iniciais: `attendance`, `commercial` e `prospecting`. Origem verificada: formulário do site, entrada direta, campanha ou atendimento humano. Maria do site e Maria dos anúncios compartilham o perfil comercial e preservam suas instruções e origens distintas. Nomes de agentes não são usados para roteamento.

## Decisões de arquitetura

1. Reutilizar o núcleo do harness (`runner`, modelo, revisão e ferramentas), com uma definição de agente específica para follow-up. Extrair a leitura de pendências hoje existente no atendimento para esse componente; não transformar a definição de atendimento de produtos em um agente universal.
2. A ficha contextual de follow-up tem namespace e versão próprios. Não sobrescrever `metadata.harness.ficha`, que pertence ao atendimento/comercial ao vivo. O contexto persistido é evidência estruturada, não raciocínio privado do modelo.
3. Usar a mesma resolução de engine tanto na criação/avaliação do candidato quanto no vencimento. A elegibilidade legada não pode descartar uma escolha de horário antes do analista contextual.
4. A seleção de conteúdo é independente do calendário e da política de envio. O modelo não retorna `scheduledAt`, quantidade de tentativas, autorização de envio ou ações executáveis de agenda.
5. Ativação por agente e lista explícita de canais, em configuração aditiva, inicialmente desligada. O perfil prospecting exige também reserva válida, vínculo de sessão e geração atuais; configurar o perfil não cria esses direitos.
6. Preservar os caminhos antigos durante a adoção. Os registros existentes mantêm seu motor e seus horários. Uma sequência contextual recebe marcador versionado ao nascer e o conserva nas próximas etapas.

Alternativas rejeitadas: copiar o harness da Villefer para todos (regras de produto, contexto padrão e teto de três tentativas); somente ampliar a frase técnica (mantém três decisões incompatíveis); ligar `FOLLOWUP_BRAIN_WORKSPACES=*` (afeta escopo diferente, não resolve as saídas dos agentes e usa cortes de contexto que não preservam integralmente as regras).

## Contrato do motor

Entrada: workspace/agente/conversa/canal, perfil e origem verificados, mensagens com IDs/autores/data, fontes aprovadas do próprio agente, regras completas do agente e instrução da etapa, tentativas efetivamente enviadas, estado de reunião e instante de análise. Evidência de formulário e disponibilidade vêm das integrações existentes; texto de um cliente não se torna uma instrução confiável.

A análise registra papel do contato, pendência, dono (`customer`, `company`, `none`), fechamento/recusa, evidências por ID/trecho e eventuais restrições temporais do cliente. Ferramentas validam que IDs e trechos existem na entrada e que fatos comerciais vêm de fontes autorizadas. Ausência de evidência gera abstenção explícita, sem inventar uma pendência.

Saída discriminada: `customer_message` com texto não vazio e revisão aprovada; `seller_reminder` com resumo interno; `skip` com código factual; `unavailable` com código técnico. Não existe `customer_message` vazio. `unavailable` usa o mecanismo limitado de recuperação existente; esgotamento fica identificado como falha, não como rascunho comercial aprovado. O contador de falhas técnicas não é o contador de contatos com o cliente.

Leitura → decisão determinística → escrita → revisão é o processo comum. O adaptador fornece regras específicas, sem injetar catálogo, empresa ou dados da Villefer em outros perfis. Regras do agente e conteúdo de referência mantêm papéis separados: instrução de comportamento não comprova preço, estoque ou integração.

Não reutilizar sem ajuste os cortes silenciosos de `followup-brain.ts` (4.000 caracteres de regras, 25 mensagens, seis fontes). O construtor contextual usa limites explícitos, inclui evidências relevantes e registra cobertura. Se não conseguir carregar regras ou evidências necessárias, abstém-se; não corta regras finais sem aviso. O orçamento deve ser parametrizado e medido, sem prometer leitura ilimitada.

## Invariantes obrigatórios

### Regras e isolamento

- Atendimento: preservar base técnica, restrições comerciais, recusas, pedido misto, proposta efetivamente entregue e ações que pertencem à empresa.
- Comercial: preservar formulário real versus entrada direta, apresentação/tom do agente, Raio-X, fontes aprovadas e agenda. Escolha de horário é pendência possível; reunião já reservada não recebe convite para reservar de novo.
- Prospecção: preservar reserva, geração, sessão, recusa/opt-out, tomada humana, bloqueio de contato automático com terceiros e proibição de criar uma sequência para uma abordagem fria sem resposta. Indicação de outro responsável vira lembrete interno, nunca novo destinatário automático.
- Nenhum follow-up executa `schedule_meeting`, transferência, desconto, anexo ou nota externa arbitrária por decisão do modelo. Agenda continua no fluxo normal de resposta; lembrete interno continua no tipo existente.
- Histórico, formulário, anexos e transcrições permanecem dados não confiáveis para instruções. Promessas antigas da empresa são fatos do histórico, não prova de execução nem conhecimento aprovado.

### Cadência e tentativas

- Reutilizar `resolveFollowupPlan`, `calculateFollowupDueAt` e os completadores existentes. Configuração válida do canal tem a precedência atual; fallback do agente mantém a semântica cumulativa em minutos úteis.
- Prymeira mantém intervalos entre envios de `120/1440/2880/5760` minutos, segunda a sexta, `09:00–18:00`, `America/Sao_Paulo`, em revisão. Não transformar esses intervalos em datas cumulativas a partir da primeira mensagem.
- Quarta etapa continua possível. Remover o teto fixo de três do caminho contextual; o limite é o plano efetivo e o teto de segurança já existente no serviço.
- Rascunho, análise, erro de provedor, revisão bloqueada, adiamento e regeneração não consomem uma tentativa enviada. Contar somente o que a conclusão canônica confirmar. Não usar `attempts` (claims/falhas técnicas) como quantidade de mensagens enviadas.
- Alterar a descrição ou o ID de uma pendência na ficha não zera o contador da sequência. Somente a atividade validada pelo lifecycle pode iniciar uma sequência nova; o analista não cria crédito adicional de tentativas.
- Não acrescentar espera silenciosa de cinco minutos, recalcular antigos `scheduledAt`, reabrir cancelados ou zerar contadores na ativação.
- Se o cliente pede uma data futura ou uma reunião já marcada torna a cadência inadequada, suspender a mensagem e apresentar motivo; não enviar antes da restrição nem reagendar por sugestão livre do modelo. Uma política de reagendamento automático fica fora desta entrega.

### Aprovação e entrega

- `humanCommercialDelivery=review` é barreira para todos os perfis, inclusive prospecção. Reserva de campanha não equivale a aprovação humana. Nenhuma liberação automática por quantidade de amostras.
- Preservar os canais explicitamente automáticos, sem ampliar os tipos hoje elegíveis. Envio automático exige simultaneamente política explícita do canal, tipo permitido, validação do perfil, ausência de risco e revisão aprovada. Dúvida ou política ausente resulta em revisão.
- Manter `expectedUpdatedAt`, claim, chave ativa única, verificação de novas mensagens, sessão/reset/geração e revalidação imediatamente antes da entrega manual ou automática.
- Mudança relevante nas regras, perfil, canal ou geração durante análise invalida a proposta antes de persistir/enviar. Guarda final dentro da fronteira transacional canônica; um hash lido apenas fora dela não basta.
- Aprovar/enviar um texto não pode agendar evento no Calendar. ACK de fila ou aceite do provedor não é confirmação de entrega. Operação incerta permanece sem reenvio automático, inclusive após rollback.

## Integração e adoção

Nova opção aditiva proposta em `behaviorConfig.contextualFollowup`: `{ version: 1, enabled: true, profile, channels: [...] }`. Ela não altera `behaviorConfig.harness` nem o fluxo de abertura/resposta dos agentes. Configuração inválida deve bloquear aquele motor, sem fallback silencioso para um perfil diferente.

Na candidatura, participação anterior pode ser comprovada por mensagem recebida ou por submissão real do formulário registrada pela automação existente. Um texto dizendo que existe formulário não basta. Essa distinção preserva o site antes da primeira resposta no WhatsApp e não autoriza acompanhamentos de abordagem fria. A promessa de uma ação da empresa não é descartada pela expressão regular legada: o analista deve poder convertê-la em lembrete interno.

Marcador proposto em `decision.contextualEngine`: `{ version: 1, profile, policyRevision }`, preservando os demais campos existentes. `policyRevision` é um hash das configurações relevantes para a análise; nunca o prompt em claro. O plano não requer migração SQL. Leitores e DTOs devem tolerar o marcador sem expor prompts, fontes ou traces privados.

Ordem de adoção após aprovação específica: execução em sombra dos três perfis; Marias no canal Prymeira, inicialmente para novas sequências e mantendo revisão; João em sombra e depois rascunhos, sem modificar campanhas; Villefer por canal, após comparar resultados com os casos já validados. Produção, backfill e geração/custo de testes reais dependem de autorização da execução, não desta PR de plano.

Rollback desliga novas adesões, mas não reenvia nem recria registros. Itens contextuais já criados continuam com o handler versionado disponível ou ficam suspensos explicitamente; nunca caem no legado por ausência de flag. Nenhuma imagem antiga incompatível com esses registros pode ser usada sem contenção prévia. Remover código antigo só em entrega posterior, quando não houver trabalho ativo dependente dele.

## Adendo técnico de entrega — implementação de 19/10/2026

A auditoria da base `993d36b` constatou que as rotas reais de follow-up ainda não usam a origem canônica `followup`: a entrega comum chama o provedor diretamente e a reserva de prospecção usa outra origem. Para cumprir a guarda transacional exigida acima, a implementação inclui um adaptador contextual de origem `followup` na fronteira canônica existente e um discriminador interno de texto no serviço/router. O contextual não atravessa o wrapper antigo de prospecção, cuja confirmação exige a origem incompatível `prospecting_delivery`. Não cria schema, fila, seleção de conexão ou caminho alternativo de transporte. Pedido contextual sem suporte canônico deve abster-se; nunca cair no envio direto.

Antes do transporte, a aprovação contextual congela ator, claim, texto/hash e revisão de política junto à reserva da Message com UUID do follow-up. A aprovação de um rascunho contextual não chama a pausa genérica de tomada humana, que cancelaria a própria sessão; isso não concede exceção às verificações de sessão, reserva ou geração. Itens antigos conservam o caminho atual. A entrega automática contextual também reserva a Message e persiste o texto final antes do envio.

A revisão de política deve ser recalculada dentro da transação canônica a partir das regras completas do agente, perfil, fontes e configuração efetiva do canal, além do estado de autoridade do domínio. Não persistir prompts em snapshots de OutboundIntent, inclusive os contidos em `behaviorConfig.packagePromptTemplate`: usar projeções com digest determinístico e leitura autoritativa sob as mesmas travas, preservando a evidência legada. A opção que desliga novas adesões não altera a identidade de sequências existentes. Mudanças desde a análise de controle humano/reset, sessão, geração ou política invalidam a proposta mesmo quando os snapshots de envio foram capturados depois da mudança.

O digest usa serialização canônica versionada, chaves ordenadas e valores nulos explícitos. Inclui escopo, identidade/tipo/status e regras completas do agente, permissões/configurações, perfil/etapa/instrução, plano efetivo e sua origem, autorização do canal, sessão/reserva/geração, controle/reset e manifesto completo ordenado das fontes aprovadas (dono/tipo/status/papel, título, conteúdo, URL e metadados de aprovação). Não inclui instante de análise, claim, contadores ou updatedAt sem significado semântico. Conteúdo externo não carregado não vira evidência factual por possuir URL.

O leitor do digest da análise e da entrega deve usar a mesma implementação. Dentro da transação canônica READ COMMITTED e da ordem existente de travas de domínio, travar o agente pai com FOR UPDATE e todas as suas fontes com FOR SHARE em ordem de ID, depois selecionar o manifesto aprovado. O pai forte serializa novas fontes pela foreign key; todas as filhas, inclusive não aprovadas, protegem mudanças de classificação. Manter até o commit da fronteira; nenhum modelo ou rede dentro da transação. Confirmar essa serialização com testes concorrentes reais, sem supor que o advisory lock protege writers que não o usam.

Âncoras contextuais podem ser mensagens outbound do lifecycle. As etapas seguintes usam ID, createdAt e ingestedAt da Message realmente persistida, enquanto o intervalo continua partindo do envio confirmado. Rejeitar âncora oculta/reset e atividade posterior relevante, excluindo apenas a própria reserva de envio. Não substituir timestamps persistidos pelo instante da conclusão.

Validação adicional obrigatória: PostgreSQL para fronteira canônica, edição no fim do prompt e configuração de canal com fences recém-capturados, inserção/edição/exclusão/reclassificação de fontes, aprovação/claim/texto adulterados, atividade nova, tomada humana/reset, sessão/reserva/geração substituídas e ausência de reenvio após aceite incerto ou falha de vinculação/conclusão. Rotas e runtime devem demonstrar que prospecção aguardando review não envia; a aprovação explícita e atual pode enviar sem pausar a sessão. Fonte/router indisponível não chama transporte direto.

## Aceitação

1. Retomada de horário gera mensagem contextual revisável, sem vocabulário técnico alheio.
2. Todos os perfis usam o mesmo processo; regras/identidade e fontes permanecem isoladas.
3. Review nunca chama transporte; automatic não ganha nenhuma elegibilidade nova.
4. Quatro etapas da Prymeira preservadas; uma tentativa só avança após envio confirmado.
5. Recusa, controle humano, resposta nova, reset e mudança de geração impedem proposta/entrega obsoleta.
6. Pendência da empresa vira lembrete, recusa/encerramento vira silêncio, falta de dados vira abstenção identificada.
7. Reunião confirmada e formulário real mantêm seus significados; nenhum evento de Calendar sai do follow-up.
8. Casos de atendimento já validados não pioram no replay comparativo; divergência é evidência revisável, não aprovação automática.
9. Esta PR contém somente documentação. Implementação, ativação e adoção de itens antigos são passos separados.
