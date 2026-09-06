# IA de apoio no Talk

Implementação local do modo assistido aprovado em 06/09/2026. Não publicada na VPS; nenhum canal real foi ativado.

## Como usar após a publicação

1. Entre na conta do vendedor e importe o agente correto nesse espaço de trabalho.
2. Como gestor, abra **Canais**, selecione o canal do piloto e configure **IA de apoio**: agente e **Sugestão a cada mensagem recebida**.
3. Revise campanhas e automações independentes. Este recurso bloqueia o agente autônomo do canal, não disparos externos.
4. No Atendimento, atribua a conversa ao vendedor. **IA de apoio** aparece ao lado de **Contato**; no celular, use o botão junto ao campo de mensagem.
5. A mensagem recebida prepara um rascunho privado. **Enviar resposta** envia após o clique; **Editar no campo** permite alterar e enviar pelo botão normal.
6. **Humano no controle** pausa a geração e invalida resultados pendentes. O campo de mensagem continua disponível. **Liberar IA** retoma sugestões, nunca envio automático.

**Orientar a IA** cria outra revisão privada. O histórico registra sugestão, orientação, texto final e vendedor. Não altera prompt, FAQ, catálogo ou outras conversas automaticamente.

## O que foi separado

- Geração: histórico, configuração do agente, fontes e leitores de anexos. Sem dependência do executor de ações ou transporte.
- Fila persistente: agrupamento de entradas em 2 segundos, limitado a 10 segundos desde a primeira; uma chamada por conversa. Nova entrada invalida a publicação anterior, mantendo a trava até o trabalhador terminar.
- Permissão: usuário autenticado do mesmo espaço; gestor ou vendedor atualmente responsável pela conversa. IDs de usuário enviados pelo navegador não são aceitos.
- Envio explícito: reserva persistida antes do transporte; repetição da mesma requisição não duplica a mensagem. Resultado incerto não é reenviado automaticamente.
- Privacidade: rascunhos e orientações não passam pelo websocket geral do espaço. O painel usa leitura autenticada enquanto está visível.

## Limites visíveis

- Contexto da IA: até 80 mensagens, 24 mil caracteres por mensagem e 120 mil no histórico. Fontes do agente: até 50 prontas, com seleção limitada pelo leitor existente.
- Até os 3 anexos de entrada mais recentes são processados por geração; leituras anteriores com cache válido são reutilizadas. Anexos não lidos ficam marcados. Reutilizam-se os limites existentes de 8 MB e 5 páginas por PDF.
- Resposta: até 4.000 caracteres. Orientação privada: até 2.000. Histórico lateral: últimas 20 revisões.
- O chat abre as últimas 100 mensagens. A IA informa quando usa apenas parte do histórico.
- Falha de provedor pede nova tentativa explícita; não há repetição ilimitada nem resposta simulada silenciosa. Trabalho abandonado pode ser recuperado até o limite de 2 tentativas.
- A aprovação do envio é o ponto em que ele é reservado. Assumir o controle depois desse ponto não desfaz uma mensagem já aprovada ou aceita pelo provedor.
- Apagar o texto copiado por completo desvincula o campo da sugestão. Reiniciar uma conversa, ação já restrita ao proprietário, também remove suas revisões privadas.

## Banco e publicação

Aplicar as migrações antes de iniciar esta versão da API:

- `20260906000100_assistant_drafts`: estado da fila, sugestões, envios e relações por espaço.
- `20260906000200_assistant_message_order`: horário de chegada no servidor para novas mensagens e índice de contexto. Mensagens antigas mantêm o campo nulo e continuam ordenadas pela data histórica.

A segunda migração corrige o caso em que a mensagem do cliente chega depois de uma resposta humana, mas o timestamp do WhatsApp, com precisão de segundos, a colocaria antes. Nenhum conteúdo histórico é reescrito.

Configurações ausentes continuam **desativadas**. Publicar API/web não escolhe canal nem ativa o agente. Antes da publicação, faça backup e preserve a imagem anterior. Não reverta para um runtime antigo enquanto canais ainda estiverem em modo assistido: o código antigo não conhece sua trava de envio.

## Checklist obrigatório com o chip real

- [ ] Usuário confirmou canal, conta e vendedor responsáveis.
- [ ] Provedor real e canal conectados; agente no espaço correto.
- [ ] Campanhas/automações independentes revisadas.
- [ ] Texto recebido gera sugestão sem responder sozinho.
- [ ] PDF, imagem e áudio reais chegam legíveis e alimentam o contexto.
- [ ] Vendedor edita e envia uma vez; texto, autoria e status conferem.
- [ ] Assumir durante a geração impede publicação; liberar retoma sem enviar.
- [ ] Conferir estoque, preços, medidas e condições na primeira rodada supervisionada.

Os testes locais de integração usam dados fictícios e um provedor HTTP local. Eles verificam funcionamento e segurança do fluxo, não a qualidade comercial de um modelo real nem o transporte do WhatsApp.

Evidências e comandos: `artifacts/assistant-pilot/verification.md`.
