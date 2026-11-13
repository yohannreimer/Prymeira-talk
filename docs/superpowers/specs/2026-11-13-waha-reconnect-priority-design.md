# Prioridade automática após reconexão WAHA

Objetivo autorizado: recuperar primeiro as mensagens do período da queda, sem esperar a fila antiga e sem alterar envio, webhooks, sessão, atendimento ou prompts.

Causa verificada: `recoverWahaWindow` tem um único cursor e um único backoff sobre `recoveredThroughAt`. Quando esse checkpoint está antigo, a leitura começa nele, mesmo após uma nova reconexão. `disconnectedAt` existe, mas não muda a prioridade. A geração física cerca as leituras; `connectedAt` é a primeira conexão e não é um marcador confiável de reconexão.

Alternativas consideradas: saltar o checkpoint perderia cobertura antiga; adicionar tabela/campos exigiria migração e ampliaria implantação. A solução escolhida mantém o checkpoint contíguo antigo e guarda duas filas limitadas no JSON já existente, com versão 2. Nenhuma migração é necessária.

Ativar duas filas quando há mais de 30 minutos de atraso ou já existe estado v2. Conexões com fila curta conservam o comportamento v1. A fila recente possui checkpoint, cursor, backoff e falhas próprios. A antiga conserva seu ponto contíguo e seu cursor. A recente vencida tem prioridade; durante seu intervalo de espera a antiga continua. Erro antigo não impede execução recente. Uma geração física nova ou novo disconnectedAt antecipa a tentativa recente. Uma única lease da conexão continua impedindo trabalhadores concorrentes.

Na primeira ativação, usar o início de queda conhecido, com ao menos 15 minutos de varredura recente e limite inicial de 15 dias; sem marcador, começar pelos últimos 15 minutos. Essa faixa não representa cobertura anterior: a fila antiga continua responsável por tudo que ficou antes dela. Após o primeiro certificado, a fila recente retoma sempre seu último ponto confirmado, inclusive após reinício ou nova geração da mesma conta. Uma conta/sessão diferente invalida essa continuidade. Janelas recentes são fixas e limitadas a quinze dias por etapa, com dez minutos de sobreposição; não usam horário do reinício como se fosse checkpoint confirmado.

Cada janela exige duas passagens esgotadas e idênticas; persistência canônica precede cursor. Nenhuma falha ou troca de geração pode avançar cobertura. Orçamentos de páginas/tempo, metadados de paginação bruta, guardas de identidade e limite de digests permanecem. Falhas e retomadas são independentes entre filas. A recuperação recente só altera seu próprio checkpoint; `recoveredThroughAt` continua significando cobertura antiga contígua.

Implantar somente imagem do worker validada por SHA/digest; API, frontend, WAHA, credenciais e volumes permanecem. Não provocar queda real para teste. Validar reconexões em PostgreSQL descartável com provedor sintético; em produção observar a prioridade recente, preservação do checkpoint antigo, saúde e tráfego real. Sem transcrições, telefones, coordenadas ou credenciais nos documentos e relatórios.
