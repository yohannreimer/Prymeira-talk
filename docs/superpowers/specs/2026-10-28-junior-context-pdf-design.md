# Junior: confirmação contextual e recuperação de PDF

Requisitos aprovados pelo usuário em 28/10/2026:

- Ao responder “os dois” à pergunta sobre U enrijecido ou U estrutural, confirmar: “Quer cotar cada perfil nas duas opções: U enrijecido e U estrutural?”. Usar a pergunta anterior como referência, sem registrar a escolha como confirmada antes do “sim”.
- Se a leitura de um PDF falhar, tentar novamente uma vez. Se falhar novamente, repassar efetivamente ao humano com o arquivo original na conversa, sem pedir outro formato ao cliente.
- A organização das perguntas técnicas não faz parte desta alteração.
- Pedido adicional do usuário: investigar e corrigir o fluxo de leitura de PDF e imagem. Evidência: três PDFs válidos com aviso de fonte AutoCAD eram barrados; o anexo atual não reaproveitava a preparação canônica já lida; erros HTTP visuais perdiam a causa operacional.

Implementação: regras de atendimento configuráveis por agente no contexto do motor; política de recuperação de PDF e imagem também opt-in por agente/canal. O motor recebe a regra no leitor e no escritor. A leitura continua respeitando os limites existentes e reaproveitando resultados já processados. Falhas persistentes usam o fluxo existente de handoff. A inspeção aceita somente o aviso AutoCAD observado e força visão. Erros HTTP recebem categorias estáveis, sem detalhes privados. Ativação do comportamento restrita ao Junior.

Validação: regressões do runtime cobrindo falha/sucesso na segunda tentativa, falha persistente no arquivo atual e em anexos anteriores do mesmo lote, cache e isolamento por configuração/canal; testes do contexto das regras e verificação TypeScript.
