# Reconexão na extensão — plano aprovado

Execução nesta tarefa, sem subagentes, conforme pedido do usuário.

**Objetivo:** não exibir nenhum aviso se ao menos uma conexão do canal estiver apta; quando nenhuma estiver apta, permitir reconectar pelo QR no painel lateral.

**Arquitetura:** manter na sessão os canais previamente verificados mesmo desconectados; ações normais continuam exigindo canal conectado no servidor. Criar duas operações limitadas da extensão (estado e QR) com checagem da empresa, perfil e número observado. Reusar os serviços físicos Evolution/WAHA, a prova de identidade e os bloqueios de ciclo já existentes; não criar canais, ativar redundância ou desconectar conexões funcionais. QR permanece só em memória e é invalidado por expiração, troca de conta/aba/canal ou recuperação.

- [x] Contratos em packages/shared/src/browser-extension.ts e executor: connection-status e reconnect com account estrito; rotas fixas, sem URLs do cliente.
- [x] Backend em browser-extension-connection.ts: status derivado da elegibilidade do roteador; sondagem limitada; QR somente de conexões já habilitadas, para gestores, revalidado antes da ação. Canais desconectados continuam identificáveis por verifiedMessagingPhoneNumber. Cobrir uma conexão saudável, ambas indisponíveis, outro número/empresa, agente, canal arquivado e indisponibilidade do provedor.
- [x] Registrar rotas privadas sem cache e com limite de requisições. Reutilizar os runtimes do app. Nenhuma migração.
- [x] Worker: manter a cerca de conta/aba antes e depois das operações e ampliar somente os dois caminhos fixos na conexão persistente.
- [x] Painel: componente ConnectionRecovery, silencioso com available=true; QR local, atualização de estado sem chamadas sobrepostas, renovação limitada a uma tentativa de 2 minutos; erro de servidor legível. Não tocar no rascunho ou navegação da conversa. Limpar contexto/sugestões enquanto sem conexão apta.
- [x] Testar contratos, acesso/backend e componente; executar testes de navegador com fixtures sintéticas, incluindo reconexão e sessão Clerk. Rodar typecheck/build dos pacotes afetados. Gerar ZIP 0.4.0 e descrever necessidade de atualizar API e extensão, sem declarar implantação não realizada.

Comandos: pnpm --filter @prymeira-talk/shared build; pnpm --filter @prymeira-talk/api prisma generate; pnpm --filter @prymeira-talk/api exec vitest run src/modules/browser-extension; pnpm --filter @prymeira-talk/extension test; pnpm --filter @prymeira-talk/extension test:browser; TEST_NATIVE_AUTH=1 pnpm --filter @prymeira-talk/extension test:browser; pnpm -r typecheck.

Verificação local concluída: 161 testes da API/provedores, 38 da extensão, 133 shared e 14 bridge/QR do web; navegador 38 cenários legacy e 39 native, sem erros de página. Typecheck dos quatro pacotes e builds API/web/extensão passaram. Integrações PostgreSQL/RabbitMQ dependem do CI. Nenhum pareamento, desconexão de produção, instalação no Chrome do usuário ou deploy foi realizado por esta implementação.
