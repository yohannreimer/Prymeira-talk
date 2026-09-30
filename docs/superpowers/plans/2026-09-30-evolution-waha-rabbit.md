# Evolution + WAHA no Talk — implementação

> Para agentes: usar subagent-driven-development por bloco, com revisão de conformidade e depois revisão de qualidade. O pedido de implementação de Yohann autoriza o trabalho nesta branch; não autoriza enviar mensagens a terceiros.

**Objetivo:** oferecer duas conexões opcionais ao mesmo número, uma conversa canônica, paridade de mídia/IA e envio único, preservando os canais atuais.

**Arquitetura:** ingresso independente confirma somente depois do RabbitMQ; consumidores persistem mensagens e trabalhos na mesma transação. Adaptadores Evolution/WAHA compartilham mídia, DTOs, runtime de IA e roteador persistente de saída.

**Stack:** TypeScript, Fastify, React, Prisma/PostgreSQL, RabbitMQ, WAHA WPP 2026.9.1, Docker Swarm.

Base: `4524fbb3e834197626d7fc6ad329a7282c562615`. Branch: `codex/talk-waha-rabbit-20260930`.

## Requisitos aprovados

- Evolution QR primeiro; botão “Gerar outro QR Code — WAHA”; estados 0/2, 1/2, 2/2, saúde e conexão de envio. QR e logout independentes. Número diferente impede ativação da segunda conexão.
- Canal lógico, IDs internos, histórico, permissões, agentes e Meta permanecem compatíveis. Migrações aditivas preenchendo canais existentes.
- Texto, áudio, imagem, figurinha, vídeo, documentos/PDF, contatos e localização usam a apresentação atual. Áudio preserva player, velocidade, original e transcrição; imagem preserva legenda/ampliação/download.
- Mídia persistida pelo Talk, baixada pelo servidor com autenticação da WAHA e origem restrita; nunca expor API key ao navegador ou relaxar proteção SSRF. Limites existentes: 25 MiB ao servir, 8 MiB quando aplicado pelo processamento.
- Processamento persistente e coordenado de mídia/transcrição, compartilhado entre ações automáticas e manuais. Deduplicar antes de efeitos. IA espera conteúdo pronto e mantém debounce, conhecimento, burst de imagens, controle humano e prospecção.
- Ingresso independente da API/web, URLs Evolution compatíveis, assinatura WAHA e isolamento por workspace/conexão. Rabbit persistente com publisher confirms, ACK manual, retries e DLQ; sem anexos binários na fila.
- Mensagem e trabalhos pendentes são atômicos. Dois eventos geram uma mensagem/não lida/acionamento lógico; guardar observações e aliases de ambas as conexões. Identidade usa canal/chat/ID WhatsApp/direção/participante, nunca texto e horário.
- Edições, exclusões e recibos resolvem aliases da mensagem alvo. Histórico importado não aciona IA; recuperar lacunas com checkpoint e sobreposição.
- Todo envio humano/IA/automação/campanha/follow-up passa pelo roteador único com intenção persistida. Manter cadência/ordem; voz deve sair como voz. Novo envio troca de conexão automaticamente; tentativa incerta nunca é reenviada automaticamente.
- Saúde a cada 15 s, falha após 3 probes, ou 3 mensagens observadas só pela outra conexão após 10 s em janela de 2 min. Ausência de tráfego e fila comum atrasada não são falha de provedor. Retorno à Evolution só após 10 min e evidência real concordante.
- Reusar e medir Swarm/VPS, volumes persistentes de mídia/sessões/broker, privacidade dos serviços internos e imagens imutáveis. Um host não tolera perda do host.
- Liberação só depois de regressões, testes de falha/durabilidade, carga 2x pico observado, homologação dos dois engines reais no mesmo número e verificação visual/multimodal. Alvos: ingresso p95 <500 ms; mensagem no inbox <=2 s após aceite, separado da mídia/IA.
- Rollback operacional preserva migrações/histórico/pendências e retorna à Evolution, sem reenvio de incertos.

## Blocos e acompanhamento

- [x] 1. Conexões físicas, cliente WAHA, contrato e gestão dos dois QR Codes; UI de canais e migração inicial. Testes de número incorreto, isolamento e compatibilidade. Implementação local aprovada por revisões de especificação e qualidade em `95fb0b8`; homologação real permanece no bloco 5.
- [ ] 2a. Normalização Evolution/WAHA, identidade canônica, aliases e observações; edições/exclusões/recibos e dois importadores históricos. Testes reais de concorrência, escopo e identidade.
- [x] 2a.1. Contratos e adaptadores puros, extração Evolution compatível e parsing de IDs/alvos/participantes WAHA WPP. Conformidade aprovada em `5cc0058` e qualidade em `dd2eb72`; 173 testes focados, typecheck e build da API aprovados. Sem modificar persistência ou índices neste marco.
- [ ] 2a.2. Schema e store canônicos, aliases/observações, resolução de chat e testes de concorrência com PostgreSQL.
- [ ] 2a.3. Integração dos writers reais Evolution, histórico e campanhas; conversão dos lookups e índices amplos depois dos leitores/escritores compatíveis.
- [ ] 2a-resolução. Quando PN/LID comprovados já pertencem a duas conversas existentes, preservar UUIDs e configurações, reunir o histórico por membros e resolver explicitamente a autoridade operacional. Quarentena de conflitos é um estágio de segurança, não conclusão do histórico único; incluir autorização das origens, controles humanos, reservas incertas e bloqueio de jobs antigos.
- [ ] 2b. RabbitMQ/ingresso/consumidor, efeitos duráveis, recuperação com checkpoints e realtime entre processos. Testes de duplicação, falhas e reentrega usando a persistência do bloco 2a.
- [ ] 3. Armazenamento e serviço comum de mídia; coordenação persistente de transcrição/leitura; integração IA. Testes de player, MIME, autorização, SSRF, retry e concorrência.
- [ ] 4. Roteador único persistente, todos os remetentes, failover/saúde/reconciliação e cadência. Testes de concorrência, tentativa incerta, eco e sessões degradadas.
- [ ] 5. Infraestrutura, migrações reais, testes de falhas/carga, homologação visual e real, revisão final, documentação e PR. Publicação depende dos critérios aprovados, não apenas de build.

## Verificação

`pnpm prisma:generate`, `pnpm typecheck`, `pnpm test`, `pnpm build`; integração com PostgreSQL e RabbitMQ reais; mídia sintética com ffmpeg/Poppler reais; interface sob CSP de produção. Registrar comandos, resultados e limitações em `docs/operations/evolution-waha-rabbit.md` sem conteúdo privado nem segredos.

## Evidências e limites desta tarefa

Esta lista registra requisitos, não afirma implementação, homologação ou publicação. Estados somente serão marcados concluídos com evidência. Nenhum estado das tarefas canônicas do Segundo Cérebro é inferido automaticamente.
