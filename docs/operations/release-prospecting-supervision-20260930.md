# Integração de prospecção e supervisão — 30/09/2026

Base de produção preservada: 45f1a2b07b3a951bc61c79fd336df5d35f3ec8c5 (localização, incluindo reconexão Evolution anterior). Prospecção recuperada: 7bedf1757864b5a13a761e31ac63458859237bc5, diff desde 3a4b2ca. Supervisão recuperada: a815b7413ea2e5b044a8986a7a19f46d09443a85, diff desde a base comum 68ed5d0. Não substituir arquivos inteiros por uma branch antiga.

A integração preserva envio/DTO/renderização de localização, isolamento de supervisão e controle humano da prospecção. O histórico somente de leitura do supervisor também renderiza localização. EvolutionClient e módulos de canais são idênticos à base 45f1a2b. VER DPS e correção de atrasos não introduzem novas alterações nesta publicação.

## Evidência atual

Node 22.22.0, pnpm 10.0.0, instalação congelada, Prisma gerado. PostgreSQL 16 descartável em loopback; nenhuma configuração de produção nos testes.

- API geral: 1.597 aprovados, 17 condicionais inicialmente pulados. Os 17 foram executados separadamente e aprovados: dez de assistente e sete de Leads.
- Shared: 77 aprovados. Web: 299 aprovados.
- Rodada crítica explícita: 65 testes aprovados, sem skips, nos arquivos de prospecção PostgreSQL, campanhas PostgreSQL, supervisão PostgreSQL e fronteira de autorização.
- Typecheck e build completos, incluindo build:prod da API, aprovados.
- Migrações: 38 em banco vazio; upgrade das 33 migrations da base para 38 preservou agente antigo como attendance, campanha antiga sem vínculo de prospecção, conteúdo existente e módulo OFF.
- Hub ↔ Talk por HTTP local: cinco vendedores, 75 pendências, páginas de 50 e 25, filtros combinados, histórico/anexo sem alterar estados do vendedor, escritas de módulo/agente/campanha proibidas ao supervisor, leitura/conclusão pelo vendedor e revogação imediata. Verificador de identidade simulado; não valida Clerk real.
- Duas falhas em testes PostgreSQL do assistente foram reproduzidas também na base 45f1a2b. Fixtures criavam mensagens inbound/outbound com status pending por padrão; agora representam delivered/sent, mantendo as mesmas asserções de controle humano e ordem de chegada. Os dez casos passaram depois dessa correção.
- SQL das cinco novas migrations idêntico à entrega 7bedf17. A primeira conserva a linha em branco final original para não mudar checksum; nenhuma outra falha de whitespace.

## Publicação e ativação

Construir API/web do mesmo SHA integrado. Conferir digests ativos e publicação concorrente; aplicar as cinco migrations com a imagem nova antes do rollout Talk. Hub aplica sua migration aditiva antes de iniciar a API. Preservar configurações/credenciais da stack e definir VITE_PRYMEIRA_HUB_URL para o Hub real.

Confirmar health/ready, imagens/tasks, rotas e interfaces depois do deploy. Manter prospecção OFF até validar Evolution/IA/JEV e o agente no workspace alvo. Publicar supervisão não cria vínculos nem concede acesso automaticamente. Registrar a identidade e os pares workspace/canal autorizados antes da ativação para o cliente.
