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

Sem as três primeiras, a ação fica desligada e nada muda. Não há migração de
banco nesta mudança.

## Ligar no agente

Em **Agentes**, abra o agente que atende o site, marque **Marcar call** em
*Conversar com o cliente* e salve. Vale incluir nas instruções do agente quando
ele deve propor a call, por exemplo: "Depois de entender a necessidade, convide
para uma call de 15 minutos e ofereça os horários disponíveis".
