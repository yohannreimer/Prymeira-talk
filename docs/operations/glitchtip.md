# GlitchTip no Talk

Estado observado em 08/10/2026: GlitchTip 6.1.8 em
`https://glitchtip.prymeiradigital.com.br`, all-in-one com PostgreSQL próprio,
fila/cache no PostgreSQL, retenção de 30 dias, limite de 0,5 CPU e 768 MB.
Estava com zero réplicas; foi reativado nesta tarefa. A instalação tinha apenas
os projetos baase-api/baase-web, três monitores do Baase e nenhuma regra ou
destinatário de alerta. `EMAIL_URL=consolemail://` escreve e-mails no log.

## Integração preparada

Criar um projeto Node.js do Talk e informar seu DSN em `GLITCHTIP_DSN` na API,
ingress e ingress_worker; `GLITCHTIP_RELEASE` deve ser o SHA da imagem realmente
implantada. Os arquivos Compose passam essas variáveis, com DSN vazio por padrão.
Sem DSN, não há envio nem inicialização do SDK. Apenas o domínio próprio acima,
via HTTPS, é aceito. Não guardar o DSN no Git ou em relatórios.

A captura cobre erros fatais, respostas 5xx da API/ingress, avisos/erros
estruturados da API com `err`, falhas de transporte, falhas de aplicação e ida
para dead-letter, recertificação, recuperação de histórico/LID e efeitos que
falham ou esgotam tentativas. Isso observa os fluxos existentes; não reexecuta
mensagens, muda tentativas, reconecta números nem chama pesquisas extras na Evolution.

Cada evento contém apenas ponto de falha, código operacional permitido, serviço
e SHA. Não envia mensagens, telefones, IDs de conexões/recibos, requisições,
credenciais, SQL, stack com variáveis, breadcrumbs ou contexto bruto. Eventos
fatais passam pela mesma reconstrução por campos permitidos. Para outros erros,
o código será UNEXPECTED_ERROR; diagnóstico detalhado continua nos logs privados.

Sem tracing, logs completos, métricas automáticas ou instrumentação de HTTP/DB.
No máximo 10 eventos/minuto/processo e uma repetição por ponto+código a cada
minuto. Esgotar tentativas usa um grupo separado das falhas transitórias.
Um erro no monitor não altera o resultado do processamento original.

## Ativação observada em produção

Em 08/10/2026, o acesso à conta existente foi recuperado pelo usuário e o projeto
Node.js `prymeira-talk` foi criado. A imagem
`add72b526add89b33475fb5a69c06f024ae994d0` foi implantada na API, ingress e
ingress_worker. Eventos reais chegaram ao projeto com release e serviço corretos,
sem um evento sintético que pudesse ser confundido com uma falha de cliente.
A prontidão pública `/api/ready` respondeu `{"ok":true,"product":"talk"}`.

As checagens de uptime foram desligadas com `GLITCHTIP_ENABLE_UPTIME=False`.
Naquele momento havia somente os três monitores antigos do Baase; seus registros
e históricos foram preservados. Isso também impede novas checagens de uptime
do Talk até que a configuração seja reavaliada.

A composição salva da aplicação principal estava atrás do estado em execução.
Ela foi reconciliada para conservar as variáveis atuais, a montagem de mídia,
limites de 2 CPUs/2 GB da API, frontend existente, banco e rotação dos logs antes
de acrescentar o monitoramento. Não guardar cópias dessa composição com segredos
em arquivos de documentação.

## Entrega dos alertas ainda pendente

O usuário escolheu a Dot Xing no Codex como destino. A captura no GlitchTip já
funciona, mas a entrega à Xing não foi configurada nem comprovada. `EMAIL_URL`
continua em `consolemail://`; não anunciar entrega por e-mail.

O MCP nativo do GlitchTip oferece ferramentas de consulta e alteração de issues;
ele permanece desabilitado e não demonstra suporte a MCP Events. Consulta por MCP
e aviso disparado por evento são fluxos diferentes. Para alertas imediatos à Dot,
será necessária uma ponte autenticada de webhook para um plugin com MCP Events,
seguida de conexão/assinatura autorizada na Dot e teste de entrega. Limitar essa
ponte ao projeto do Talk e aos dados operacionais permitidos.

Referências: [MCP do GlitchTip](https://glitchtip.com/documentation/mcp/),
[MCP Events em dots](https://developers.openai.com/plugins/build/mcp-events).

## Alternativas e comprovação de entrega

1. Preservar a conta existente; novas senhas são definidas pelo usuário.
2. Configurar SMTP/Anymail válido, remetente autorizado e destinatário escolhido.
   Não redirecionar e-mails para um webhook desconhecido nem reutilizar credenciais
   de outro serviço sem autorização. Criar a regra de erro e uptime no projeto.
3. Implantar a imagem contendo esta integração e configurar o DSN nos três serviços.
4. Enviar um evento sintético sem dados de clientes ao projeto do Talk, verificar
   recebimento, release e entrega do alerta ao destinatário. A captura e release já
   foram comprovadas com eventos reais; entrega externa continua pendente.
5. Monitores de disponibilidade devem consultar endpoints públicos de saúde/readiness
   existentes. Um heartbeat do worker exige um checkpoint que prove progresso real;
   réplicas 1/1 ou apenas o ingresso HTTP disponível não comprovam processamento.

## Limites

GlitchTip no mesmo VPS não consegue notificar se o VPS inteiro cair. É necessário
um verificador externo para esse caso. CPU/RAM/disco/steal por host e contêiner
exigem coleta de métricas separada. Esta integração não implementa essas métricas,
detecção de silêncio por canal nem auditoria contínua de filas já em dead-letter.
Ausência de mensagens novas isoladamente não prova defeito no canal.

Os monitores antigos do Baase estavam marcados como indisponíveis na inspeção;
confirmar se o produto deve estar ativo antes de habilitar seus alertas.
