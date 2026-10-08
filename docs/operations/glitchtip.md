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

## Ativação e comprovação

1. Recuperar acesso à conta existente; a nova senha deve ser definida pelo usuário.
2. Configurar SMTP/Anymail válido, remetente autorizado e destinatário escolhido.
   Não redirecionar e-mails para um webhook desconhecido nem reutilizar credenciais
   de outro serviço sem autorização. Criar a regra de erro e uptime no projeto.
3. Implantar a imagem contendo esta integração e configurar o DSN nos três serviços.
4. Enviar um evento sintético sem dados de clientes ao projeto do Talk, verificar
   recebimento, release e entrega do alerta ao destinatário. Isto ainda está pendente
   enquanto acesso e envio de e-mail não estiverem resolvidos.
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
