# Automações: gatilho "Webhook externo"

O gatilho **Webhook externo** liga um formulário de site (ou qualquer sistema
que faça um `POST` com JSON) a uma automação do Talk. Exemplo de uso: o
visitante envia o formulário, vê "Recebido" e, alguns segundos depois, o agente
de IA do Talk puxa a conversa no WhatsApp usando os dados que ele preencheu.

O recurso só aparece dentro das automações que usam esse gatilho. Não há menu
nem configuração global nova.

## Como conectar um formulário

1. Em **Automações**, clique em **Criar fluxo** (ou abra um fluxo existente).
2. Selecione o bloco de gatilho e, em **Tipo de gatilho**, escolha
   **Webhook externo**.
3. Em **Canal do WhatsApp**, escolha o número que vai falar com o contato.
4. Monte o restante do fluxo. O caso típico é:
   `Webhook externo → Adicionar tag → Ativar agente`.
   - No **Ativar agente**, escreva uma instrução de abertura, por exemplo:
     `Cumprimente {{nome}}, comente a dor "{{dor}}" e proponha agendar uma call.`
5. Clique em **Salvar**. O bloco do gatilho passa a mostrar o **Link do
   webhook** com o botão **Copiar link**.
6. Ative o fluxo. Fluxos pausados respondem `404` e não processam envios.
7. No site, envie um `POST` com JSON para o link copiado.

Em produção o link tem o formato:

```txt
https://talk.prymeiradigital.com.br/api/webhooks/automations/<token>
```

O token no link é a credencial. Quem tiver o link consegue disparar o fluxo.
Se o link vazar, use **Regenerar link**: o link anterior para de funcionar na
hora, e o site precisa ser atualizado com o novo.

## Formato do envio

- `Content-Type: application/json` (também aceitamos `text/plain` com JSON no
  corpo, para envios simples do navegador).
- Telefone obrigatório em `whatsapp`, `telefone` ou `phone`. Aceita qualquer
  formatação; números com DDD (10 ou 11 dígitos) recebem o `55` do Brasil.
- Nome opcional em `nome` ou `name`.
- Os demais campos são livres e aparecem na conversa para a equipe.
- Limite de 16 KB por envio.

Exemplo (formulário do site da Prymeira):

```json
{
  "nome": "Joana Silva",
  "whatsapp": "(47) 99999-1234",
  "empresa": "Metalúrgica Joana",
  "faturamento": "R$ 1 a 5 milhões",
  "dor": "Caixa apertado",
  "equipe": ["Financeiro", "Comercial"],
  "utm": { "source": "instagram", "campaign": "outubro" },
  "pagina": "/diagnostico",
  "enviado_em": "2026-10-11T12:00:00.000Z"
}
```

Exemplo de envio no site:

```js
await fetch("https://talk.prymeiradigital.com.br/api/webhooks/automations/<token>", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(dadosDoFormulario)
});
// Mostre "Recebido" ao visitante quando a resposta for 202.
```

Se o site tiver Content-Security-Policy, inclua o domínio do Talk em
`connect-src`.

Para testar sem o site, com o fluxo ativo:

```sh
curl -i -X POST "https://talk.prymeiradigital.com.br/api/webhooks/automations/<token>" \
  -H "Content-Type: application/json" \
  -d '{"nome":"Teste","whatsapp":"(47) 99999-1234","dor":"teste do webhook"}'
```

O botão **Simular real** do histórico simula uma mensagem recebida e não se
aplica a este gatilho.

## Respostas

| Código | Significado |
| --- | --- |
| `202` | Recebido. O processamento continua em segundo plano. |
| `400` | O corpo não é um objeto JSON. |
| `404` | Link desconhecido, regenerado, fluxo pausado ou sem o gatilho. |
| `413` | Corpo maior que 16 KB. |
| `422` | Telefone ausente ou inválido. |
| `429` | Mais de 30 envios por minuto para o mesmo link. |

Envios repetidos com o mesmo telefone e os mesmos dados em até 10 minutos são
respondidos com `202`, mas não iniciam outra execução. Os campos `enviado_em`,
`submitted_at` e `timestamp` são ignorados nessa comparação, para que um
clique duplo no botão não gere duas conversas.

## O que acontece no Talk

1. O contato é localizado pelo telefone ou criado. Um nome que já existe no
   Talk é mantido; o nome do formulário só preenche contatos sem nome.
2. A conversa do contato no canal escolhido é aberta (ou reaberta).
3. Os dados do formulário entram na conversa como um evento do sistema,
   em linhas legíveis ("Nome: Joana", "Dor: Caixa apertado"...).
4. O fluxo roda a partir do gatilho. Os campos do JSON podem ser usados como
   variáveis em **Enviar mensagem**, **Criar nota interna**, legendas e na
   instrução do **Ativar agente**: `{{nome}}`, `{{dor}}`, `{{empresa}}`,
   `{{utm.source}}`. Campos inexistentes viram texto vazio.
5. Com **Ativar agente**, o agente envia a primeira mensagem depois do tempo
   de espera configurado para respostas (padrão de 40 segundos), já sabendo que
   o contato veio de um formulário. Depois disso a conversa segue normalmente.

O histórico de cada envio aparece em **Histórico** no editor do fluxo.

## Limitações atuais

- **Canais da API oficial (Meta):** a primeira mensagem para quem não falou
  com o número nas últimas 24 horas exige template aprovado, e o bloco
  **Enviar template** ainda não está disponível. Com canal Meta o contato, a
  conversa, tags e notas são registrados, mas os passos de envio e o agente
  ficam como "pulados" com o motivo no histórico. Use um canal Evolution para
  que o agente puxe a conversa.
- O agente só envia mensagens se tiver a ação "Enviar mensagem" liberada, se
  a conversa não estiver sob controle humano e se o canal não estiver em modo
  assistido. Agentes configurados para "só conversas novas" passam a conversa
  para humano se ela já tiver mensagens antes do formulário.
- O link é público por natureza: qualquer pessoa com o link pode enviar dados
  para números quaisquer, até 30 vezes por minuto. Em sites com muito tráfego,
  vale proteger o formulário com captcha antes do envio.
