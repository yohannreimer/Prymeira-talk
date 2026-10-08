# Alertas do GlitchTip para Dot Xing

Desenho aprovado por Yohann em 08/10/2026: criar ponte no servidor para entrega
por eventos, preservando performance desativada e consumo limitado.

## Fluxo e escopo

Regra nativa do projeto prymeira-talk (quantidade 1, janela 1 minuto) → webhook
autenticado → fila persistente → callback MCP Events da Dot Xing. O webhook é
disparado pela cadência interna do GlitchTip; entrega por eventos não promete
latência zero. A versão 6.1.8 suprime notificações repetidas de problemas ainda
abertos e rearma notificações quando um problema resolvido reabre. Não prometer
um aviso por cada exceção repetida. Não criar polling no Mac.

Extensão pequena na imagem fixa GlitchTip 6.1.8, no mesmo processo ASGI. Preservar
inicialização, worker e servidor HTTP existentes; substituir somente o catálogo
MCP por consultas de estado de entrega e eventos do Talk. Reutilizar OAuth do
GlitchTip, exigir event:read e acesso atual ao projeto, sem ferramentas para
alterar issues, clientes ou serviços. Não copiar credenciais do banco para um
novo serviço. Limites atuais de CPU/memória permanecem.

## Dados e segurança

Reconstruir cada aviso por campos permitidos: ponto de falha, código operacional,
serviço, release validada, horário e link interno do GlitchTip. Não encaminhar
mensagens, telefones, payloads, stack traces, tokens ou outros projetos. Webhook
autenticado por segredo próprio; estado de assinaturas cifrado e persistente.

MCP 2.0 versão 2026-07-28: server/discover, events/list, events/subscribe e
events/unsubscribe. Callback verificado por desafio assinado Standard Webhooks.
HTTPS obrigatório; validar todos os IPs DNS na conexão e fixar IP público mantendo
hostname TLS; bloquear redirects. Assinaturas idempotentes, expiração finita,
revogação e renovação de segredo com janela curta de rotação. Revalidar usuário,
escopo e projeto antes das entregas.

## Confiabilidade e recursos

SQLite em volume próprio, limites de tamanho/quantidade e retenção. Persistir
antes de responder ao webhook. Retry limitado com backoff, mesmo eventId,
assinatura renovada; parar em 410/413. Unsubscribe/expiração/revogação impedem
entregas. Um worker dorme quando ocioso, sem consultar APIs ou histórico.
Expor estado agregado sem destinos, segredos ou dados brutos. Logs categorizados.

## Comprovação e limites

Testar privacidade, autenticação, isolamento de projetos, DNS/SSRF, assinatura,
desafio, duplicatas, restart, expiração, revogação, rotação e retry. Validar imagem
contra GlitchTip 6.1.8 e preservar ingestão/login existentes. Antes da ativação,
revisar mudança concreta de acesso OAuth; depois, comprovar assinatura real da
Dot, recebimento visível de aviso sintético claramente marcado e consumo.

Não considerar 2xx do callback como prova de processamento pela Dot. GlitchTip
no mesmo VPS não avisa se o VPS inteiro cair; CPU/disco/silêncio de canais ficam
fora deste escopo. Não reativar automações canceladas nem serviços pausados.

Fontes: https://developers.openai.com/plugins/build/mcp-events e código oficial
GlitchTip tag v6.1.8 (alerts/tasks.py, event_ingest/process_event.py,
oauth/provider.py e glitchtip/asgi.py).
