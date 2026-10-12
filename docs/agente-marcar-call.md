# Agente marcando call na agenda Google

Com a ação **Marcar call** ligada, o agente recebe os próximos horários livres
da sua agenda Google, oferece 2 ou 3 opções ao contato e, quando ele escolhe,
cria o evento com link do Google Meet. A resposta sai com o link da call, e uma
nota interna registra o horário e o evento.

## Como funciona

- Os horários vêm do free/busy da agenda: só aparece o que está livre, dentro
  da janela configurada (padrão: seg a sex, 09:00 às 18:00, a partir de 2 horas
  depois de agora, nos próximos 7 dias, em intervalos de 30 minutos).
- Antes de marcar, o Talk confere de novo se o horário continua livre. Se foi
  ocupado nesse meio tempo, o agente responde oferecendo outros horários.
- Se o contato já tem uma call marcada por essa conversa e pede outro horário,
  a nova marcação substitui a antiga (o evento antigo é apagado).
- Se a agenda Google falhar (credencial inválida, Google fora do ar), o agente
  não confirma nada: a conversa vai para o time com o motivo.
- Se o contato passou um e-mail (por exemplo no formulário do site), ele entra
  como convidado do evento e recebe o convite do Google. Sem e-mail, o link do
  Meet vai só pelo WhatsApp.

## O que você precisa providenciar (uma vez)

1. **Projeto no Google Cloud**: em <https://console.cloud.google.com>, crie um
   projeto (ex.: "Prymeira Talk") e ative a **Google Calendar API** em
   *APIs e serviços > Biblioteca*.
2. **Tela de consentimento OAuth**: em *APIs e serviços > Tela de consentimento
   OAuth* (ou *Google Auth Platform*), tipo **Externo**, preencha nome e e-mail.
   Depois clique em **Publicar app** (status *Em produção*). Em *Teste*, o token
   expira em 7 dias. Não precisa enviar para verificação: como só você usa,
   basta aceitar o aviso "app não verificado" na hora de autorizar.
3. **Credencial**: em *Credenciais > Criar credenciais > ID do cliente OAuth*,
   tipo **App para computador**. Guarde o *Client ID* e o *Client secret*.
4. **Refresh token**: no seu computador, na pasta do repositório, rode

   ```bash
   node apps/api/scripts/google-calendar-token.mjs <CLIENT_ID> <CLIENT_SECRET>
   ```

   O navegador abre; entre com a conta Google da agenda onde as calls devem
   cair e autorize. O terminal imprime as três variáveis.

## Configurar no servidor

No Portainer, nas variáveis do stack do `talk_api`:

| Variável | Obrigatória | Padrão | O que é |
| --- | --- | --- | --- |
| `GOOGLE_CALENDAR_CLIENT_ID` | sim | | Client ID do passo 3 |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | sim | | Client secret do passo 3 |
| `GOOGLE_CALENDAR_REFRESH_TOKEN` | sim | | Saída do script do passo 4 |
| `GOOGLE_CALENDAR_ID` | não | `primary` | Outra agenda da conta, se não for a principal |
| `MEETING_TIMEZONE` | não | `America/Sao_Paulo` | Fuso dos horários oferecidos |
| `MEETING_DURATION_MINUTES` | não | `15` | Duração da call |
| `MEETING_HOURS` | não | `09:00-18:00` | Janela diária de horários |
| `MEETING_WEEKDAYS` | não | `1-5` | Dias da semana (0 = domingo), ex.: `1-5` ou `1,3,5` |
| `MEETING_MIN_NOTICE_MINUTES` | não | `120` | Antecedência mínima |
| `MEETING_DAYS_AHEAD` | não | `7` | Quantos dias à frente oferecer |
| `MEETING_TITLE` | não | `Call Prymeira` | Título do evento (o nome do contato é somado) |

Sem as três primeiras, a ação fica desligada e nada muda.

As mensagens antes da call (abaixo) guardam a programação na tabela
`meeting_reminders`: rode `pnpm --filter @prymeira-talk/api migrate:deploy`
(ou o passo de migração do deploy) ao subir esta versão.

## Ligar no agente

Em **Agentes**, abra o agente que atende o site, marque **Marcar call** em
*Conversar com o cliente* e salve. Vale incluir nas instruções do agente quando
ele deve propor a call, por exemplo: "Depois de entender a necessidade, convide
para uma call de 15 minutos e ofereça os horários disponíveis".

## Mensagens antes da call

Com **Marcar call** ligado, a aba de ações do agente mostra o cartão
**Mensagens antes da call**. Cada call que o agente marcar recebe essas
mensagens no WhatsApp, sozinhas, no tempo configurado.

- Por padrão vem um lembrete 1 hora antes: "Oi, {{primeiro_nome}}! Passando pra
  lembrar da nossa call hoje às {{hora}}. Até já!".
- Até 5 lembretes por call (por exemplo, 3 horas antes e 1 hora antes), cada um
  com até 3 mensagens, enviadas em ordem.
- Cada mensagem pode ter texto (links funcionam), um arquivo por link
  (imagem, vídeo ou PDF; o texto vira a legenda) ou os dois.
- No texto: `{{nome}}`, `{{primeiro_nome}}`, `{{dia}}`, `{{hora}}`,
  `{{horario}}` (dia e hora juntos) e `{{link}}` (o link do Meet). Uma linha
  como "Link: {{link}}" some quando a call não tem link.
- Se a call for remarcada pelo agente, os lembretes da antiga são cancelados e
  os novos seguem o novo horário. Antes de enviar, o Talk confere a agenda: se
  a call foi apagada ou movida à mão, o lembrete não sai.
- Lembretes cujo horário já passou na hora da marcação são pulados (uma call
  marcada para daqui a 2 horas não recebe o de 3 horas antes).
- A nota interna da marcação lista os lembretes programados, e cada mensagem
  enviada aparece na conversa.

## Responder em mensagens separadas

Em **Como ele responde**, a opção **Responder em mensagens separadas** faz o
agente mandar cada parágrafo da resposta como uma mensagem própria no
WhatsApp (até 3), com "digitando..." antes de cada uma, como uma pessoa faria.
O link da call, quando houver, vai na última.


## Mover o lead no Kanban ao confirmar

Em **Agentes > O que ele pode fazer**, com **Marcar call** e **Adicionar tag** ligados, selecione **Tag ao confirmar a call**. A lista contém somente as tags ativas permitidas ao agente. Configure essa tag como gatilho da etapa **Call marcada** no board e vincule o board ao canal usado pelo fluxo.

O servidor aplica a tag apenas após a agenda confirmar o agendamento, inclusive remarcações, e move o card imediatamente. O evento confirmado prevalece sobre tags antigas de andamento e pode trazer o card de uma etapa posterior para a etapa da call. Horário ocupado, erro da agenda ou falta de permissão não aplicam a tag. A IA não pode antecipar a tag configurada por inferência. Sem uma tag selecionada, o comportamento anterior continua. Não há nova migração de banco.
