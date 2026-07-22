import type { MessageDirection, PrismaClient } from "@prisma/client";
import type { RealtimeEvent } from "@prymeira-talk/shared";
import { toConversationDto, toMessageDto } from "../conversations/conversations.service.js";

type DemoMessage = [MessageDirection, string, Date];

export interface DemoResetResult {
  workspaceId: string;
  users: number;
  conversations: number;
  contacts: number;
  agents: number;
}

export interface DemoLeadResult {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  created: boolean;
}

export interface DemoRealtime {
  publish(event: RealtimeEvent): void;
}

const ids = {
  channel: "10000000-0000-4000-8000-000000000001",
  board: "70000000-0000-4000-8000-000000000001",
  agent: "80000000-0000-4000-8000-000000000001",
  knowledge: "81000000-0000-4000-8000-000000000001",
  carlosConversation: "50000000-0000-4000-8000-000000000010",
  carlosContact: "60000000-0000-4000-8000-000000000010",
  carlosSession: "82000000-0000-4000-8000-000000000001"
} as const;

const users = [
  {
    id: "20000000-0000-4000-8000-000000000001",
    clerkUserId: "demo_agent_marina",
    displayName: "Marina Costa",
    role: "manager" as const,
    presenceState: "online"
  },
  {
    id: "20000000-0000-4000-8000-000000000002",
    clerkUserId: "demo_agent_rafael",
    displayName: "Rafael Nunes",
    role: "agent" as const,
    presenceState: "online"
  },
  {
    id: "20000000-0000-4000-8000-000000000003",
    clerkUserId: "demo_agent_bia",
    displayName: "Bia Almeida",
    role: "agent" as const,
    presenceState: "busy"
  },
  {
    id: "20000000-0000-4000-8000-000000000004",
    clerkUserId: "demo_agent_lucas",
    displayName: "Lucas Ribeiro",
    role: "agent" as const,
    presenceState: "online"
  },
  {
    id: "20000000-0000-4000-8000-000000000005",
    clerkUserId: "demo_agent_fernanda",
    displayName: "Fernanda Lima",
    role: "agent" as const,
    presenceState: "offline"
  }
];

const departments = [
  {
    id: "30000000-0000-4000-8000-000000000001",
    name: "Vendas",
    description: "Orçamentos, negociação e novos negócios.",
    routingOrder: 1,
    distributionMode: "round_robin" as const,
    slaFirstResponseMinutes: 5,
    slaResolutionMinutes: 240
  },
  {
    id: "30000000-0000-4000-8000-000000000002",
    name: "Suporte",
    description: "Dúvidas de entrega e pós-venda.",
    routingOrder: 2,
    distributionMode: "least_open" as const,
    slaFirstResponseMinutes: 10,
    slaResolutionMinutes: 480
  },
  {
    id: "30000000-0000-4000-8000-000000000003",
    name: "Financeiro",
    description: "Cobrança, faturamento e segunda via.",
    routingOrder: 3,
    distributionMode: "manual" as const,
    slaFirstResponseMinutes: 15,
    slaResolutionMinutes: 480
  }
];

const tags = [
  { id: "40000000-0000-4000-8000-000000000001", name: "Orçamento quente", color: "#D8732F" },
  { id: "40000000-0000-4000-8000-000000000002", name: "Follow-up", color: "#6B5BB5" },
  { id: "40000000-0000-4000-8000-000000000003", name: "Pós-venda", color: "#34765A" },
  { id: "40000000-0000-4000-8000-000000000004", name: "Suporte", color: "#4F6F9F" }
];

const stages = [
  { id: "71000000-0000-4000-8000-000000000001", name: "Novo", order: 0, color: "#E8F1FF" },
  { id: "71000000-0000-4000-8000-000000000002", name: "Qualificado", order: 1, color: "#E7F6ED" },
  { id: "71000000-0000-4000-8000-000000000003", name: "Proposta enviada", order: 2, color: "#FFF3D9" },
  { id: "71000000-0000-4000-8000-000000000004", name: "Follow-up", order: 3, color: "#F3E8FF" },
  { id: "71000000-0000-4000-8000-000000000005", name: "Ganho", order: 4, color: "#DFF3EA" }
];

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function hoursAgo(hours: number) {
  return minutesAgo(hours * 60);
}

const conversationSeeds = () => [
  {
    conversationId: "50000000-0000-4000-8000-000000000001",
    contactId: "60000000-0000-4000-8000-000000000001",
    name: "Ana Beatriz",
    phone: "5547999910101",
    email: "ana@clinicaaurora.com.br",
    company: "Clínica Aurora",
    status: "open" as const,
    priority: "high" as const,
    unreadCount: 3,
    departmentId: departments[0].id,
    assignedUserId: users[0].id,
    stageOrder: 2,
    tagIds: [tags[0].id],
    messages: [
      ["inbound", "Olá, preciso de um orçamento para equipar nossa nova unidade.", minutesAgo(18)],
      ["outbound", "Claro, Ana. Vou organizar os itens e o prazo de entrega.", minutesAgo(12)],
      ["inbound", "Consegue me enviar a proposta ainda hoje?", minutesAgo(4)]
    ] satisfies DemoMessage[]
  },
  {
    conversationId: "50000000-0000-4000-8000-000000000002",
    contactId: "60000000-0000-4000-8000-000000000002",
    name: "João Martins",
    phone: "5551999820202",
    email: "compras@jmautopecas.com.br",
    company: "JM Auto Peças",
    status: "pending" as const,
    priority: "normal" as const,
    unreadCount: 1,
    departmentId: departments[1].id,
    assignedUserId: users[1].id,
    stageOrder: 4,
    tagIds: [tags[3].id],
    messages: [
      ["inbound", "O rastreio do meu pedido não atualizou hoje.", minutesAgo(49)],
      ["outbound", "Vou confirmar a posição com a transportadora.", minutesAgo(35)],
      ["inbound", "Perfeito, fico aguardando.", minutesAgo(27)]
    ] satisfies DemoMessage[]
  },
  {
    conversationId: "50000000-0000-4000-8000-000000000003",
    contactId: "60000000-0000-4000-8000-000000000003",
    name: "Camila Rocha",
    phone: "5511999730303",
    email: "camila@studiorocha.com.br",
    company: "Studio Rocha",
    status: "open" as const,
    priority: "high" as const,
    unreadCount: 2,
    departmentId: departments[0].id,
    assignedUserId: users[2].id,
    stageOrder: 1,
    tagIds: [tags[0].id],
    messages: [
      ["inbound", "Vocês atendem pedidos recorrentes para empresas?", minutesAgo(82)],
      ["outbound", "Sim, inclusive com condições por volume.", minutesAgo(74)],
      ["inbound", "Podemos marcar uma call ainda hoje?", minutesAgo(58)]
    ] satisfies DemoMessage[]
  },
  {
    conversationId: "50000000-0000-4000-8000-000000000004",
    contactId: "60000000-0000-4000-8000-000000000004",
    name: "Pedro Almeida",
    phone: "5548999640404",
    email: "financeiro@almeidaenergia.com.br",
    company: "Almeida Energia",
    status: "closed" as const,
    priority: "low" as const,
    unreadCount: 0,
    departmentId: departments[2].id,
    assignedUserId: users[1].id,
    stageOrder: 4,
    tagIds: [tags[2].id],
    messages: [
      ["inbound", "Recebi a segunda via, obrigado.", hoursAgo(4)],
      ["outbound", "Ótimo, Pedro. Fechei o atendimento por aqui.", hoursAgo(3)]
    ] satisfies DemoMessage[]
  },
  {
    conversationId: "50000000-0000-4000-8000-000000000005",
    contactId: "60000000-0000-4000-8000-000000000005",
    name: "Larissa Gomes",
    phone: "5531999550505",
    email: "larissa@gomesmoda.com.br",
    company: "Gomes Moda",
    status: "open" as const,
    priority: "normal" as const,
    unreadCount: 0,
    departmentId: departments[0].id,
    assignedUserId: users[3].id,
    stageOrder: 3,
    tagIds: [tags[1].id],
    messages: [
      ["inbound", "A condição da proposta continua válida esta semana?", hoursAgo(7)],
      ["outbound", "Continua sim. Posso reservar o estoque até sexta.", hoursAgo(6)]
    ] satisfies DemoMessage[]
  },
  {
    conversationId: "50000000-0000-4000-8000-000000000006",
    contactId: "60000000-0000-4000-8000-000000000006",
    name: "Marcelo Souza",
    phone: "5541999460606",
    email: "marcelo@souzamanutencao.com.br",
    company: "Souza Manutenção",
    status: "open" as const,
    priority: "normal" as const,
    unreadCount: 1,
    departmentId: departments[0].id,
    assignedUserId: users[4].id,
    stageOrder: 0,
    tagIds: [],
    messages: [["inbound", "Vocês entregam na região metropolitana?", hoursAgo(9)]] satisfies DemoMessage[]
  },
  {
    conversationId: "50000000-0000-4000-8000-000000000007",
    contactId: "60000000-0000-4000-8000-000000000007",
    name: "Renata Vieira",
    phone: "5511999370707",
    email: "renata@vieiraengenharia.com.br",
    company: "Vieira Engenharia",
    status: "closed" as const,
    priority: "normal" as const,
    unreadCount: 0,
    departmentId: departments[0].id,
    assignedUserId: users[0].id,
    stageOrder: 4,
    tagIds: [tags[2].id],
    messages: [
      ["inbound", "A entrega chegou completa. Obrigada pelo acompanhamento.", hoursAgo(15)],
      ["outbound", "Conte com a gente nos próximos pedidos, Renata.", hoursAgo(14)]
    ] satisfies DemoMessage[]
  },
  {
    conversationId: "50000000-0000-4000-8000-000000000008",
    contactId: "60000000-0000-4000-8000-000000000008",
    name: "Bruno Tavares",
    phone: "5531999280808",
    email: "bruno@tavaresobras.com.br",
    company: "Tavares Obras",
    status: "pending" as const,
    priority: "high" as const,
    unreadCount: 0,
    departmentId: departments[0].id,
    assignedUserId: users[3].id,
    stageOrder: 3,
    tagIds: [tags[1].id],
    messages: [
      ["outbound", "Bruno, consegui uma condição melhor para pagamento faturado.", hoursAgo(20)],
      ["inbound", "Vou validar com o financeiro e retorno amanhã.", hoursAgo(18)]
    ] satisfies DemoMessage[]
  },
  {
    conversationId: "50000000-0000-4000-8000-000000000009",
    contactId: "60000000-0000-4000-8000-000000000009",
    name: "Paula Freitas",
    phone: "5561999190909",
    email: "paula@freitaslogistica.com.br",
    company: "Freitas Logística",
    status: "open" as const,
    priority: "normal" as const,
    unreadCount: 1,
    departmentId: departments[1].id,
    assignedUserId: users[2].id,
    stageOrder: 2,
    tagIds: [tags[3].id],
    messages: [["inbound", "Preciso ajustar o endereço de entrega do pedido.", hoursAgo(22)]] satisfies DemoMessage[]
  },
  {
    conversationId: ids.carlosConversation,
    contactId: ids.carlosContact,
    name: "Carlos Mendes",
    phone: "5547999101010",
    email: "carlos@construtorahorizonte.com.br",
    company: "Construtora Horizonte",
    status: "closed" as const,
    priority: "normal" as const,
    unreadCount: 0,
    departmentId: departments[0].id,
    assignedUserId: null,
    stageOrder: 0,
    tagIds: [],
    messages: [["outbound", "Atendimento anterior finalizado.", hoursAgo(48)]] satisfies DemoMessage[]
  }
];

async function clearWorkspace(prisma: PrismaClient, workspaceId: string) {
  await prisma.aiAgentPendingReply.deleteMany({ where: { workspaceId } });
  await prisma.aiAgentRun.deleteMany({ where: { workspaceId } });
  await prisma.aiAgentSession.deleteMany({ where: { workspaceId } });
  await prisma.aiAgentAllowedTag.deleteMany({ where: { workspaceId } });
  await prisma.aiKnowledgeSource.deleteMany({ where: { workspaceId } });
  await prisma.aiAgent.deleteMany({ where: { workspaceId } });
  await prisma.campaignRecipient.deleteMany({ where: { workspaceId } });
  await prisma.campaign.deleteMany({ where: { workspaceId } });
  await prisma.automationRun.deleteMany({ where: { workspaceId } });
  await prisma.automationRule.deleteMany({ where: { workspaceId } });
  await prisma.crmSyncAction.deleteMany({ where: { workspaceId } });
  await prisma.aiActionLog.deleteMany({ where: { workspaceId } });
  await prisma.conversationTag.deleteMany({ where: { workspaceId } });
  await prisma.message.deleteMany({ where: { workspaceId } });
  await prisma.contactNote.deleteMany({ where: { workspaceId } });
  await prisma.contactBoardMembership.deleteMany({ where: { workspaceId } });
  await prisma.conversation.deleteMany({ where: { workspaceId } });
  await prisma.contact.deleteMany({ where: { workspaceId } });
  await prisma.contactBoardStageTag.deleteMany({ where: { workspaceId } });
  await prisma.contactBoardChannel.deleteMany({ where: { workspaceId } });
  await prisma.contactBoardStage.deleteMany({ where: { workspaceId } });
  await prisma.contactBoard.deleteMany({ where: { workspaceId } });
  await prisma.departmentChannelRule.deleteMany({ where: { workspaceId } });
  await prisma.departmentMember.deleteMany({ where: { workspaceId } });
  await prisma.quickReply.deleteMany({ where: { workspaceId } });
  await prisma.integrationConfig.deleteMany({ where: { workspaceId } });
  await prisma.auditLog.deleteMany({ where: { workspaceId } });
  await prisma.tag.deleteMany({ where: { workspaceId } });
  await prisma.channel.deleteMany({ where: { workspaceId } });
  await prisma.department.deleteMany({ where: { workspaceId } });
  await prisma.userProfile.deleteMany({ where: { workspaceId } });
  await prisma.workspaceMirror.deleteMany({ where: { workspaceId } });
}

async function seedWorkspace(prisma: PrismaClient, workspaceId: string): Promise<DemoResetResult> {
  await clearWorkspace(prisma, workspaceId);

  await prisma.workspaceMirror.create({
    data: {
      workspaceId,
      name: "Nova Base Suprimentos",
      plan: "demo",
      limits: { conversations: 50, agents: 5 }
    }
  });

  await prisma.userProfile.createMany({ data: users.map((user) => ({ ...user, workspaceId })) });
  await prisma.department.createMany({
    data: departments.map((department) => ({
      ...department,
      workspaceId,
      businessHours: {
        mode: "business",
        timezone: "America/Sao_Paulo",
        weekdays: [1, 2, 3, 4, 5],
        start: "08:00",
        end: "18:00"
      }
    }))
  });
  await prisma.channel.create({
    data: {
      id: ids.channel,
      workspaceId,
      provider: "evolution",
      providerKey: "demo-evolution",
      displayName: "WhatsApp Comercial",
      phoneNumber: "+55 47 99999-0000",
      status: "connected"
    }
  });
  await prisma.departmentMember.createMany({
    data: users.map((user, index) => ({
      workspaceId,
      departmentId: departments[0].id,
      userId: user.id,
      role: index === 0 ? "supervisor" : "agent",
      permissions: { view: true, reply: true, transfer: true, close: true }
    }))
  });
  await prisma.departmentChannelRule.create({
    data: {
      workspaceId,
      departmentId: departments[0].id,
      channelId: ids.channel,
      enabled: true,
      priority: 1
    }
  });
  await prisma.tag.createMany({
    data: tags.map((tag) => ({
      ...tag,
      workspaceId,
      useGuide: tag.name === "Orçamento quente" ? "Lead com prazo e necessidade confirmados." : ""
    }))
  });
  await prisma.contactBoard.create({
    data: {
      id: ids.board,
      workspaceId,
      name: "Pipeline comercial",
      description: "Funil principal da equipe de vendas.",
      isPrimaryPipeline: true
    }
  });
  await prisma.contactBoardStage.createMany({
    data: stages.map((stage) => ({ ...stage, workspaceId, boardId: ids.board }))
  });
  await prisma.contactBoardChannel.create({
    data: { workspaceId, boardId: ids.board, channelId: ids.channel }
  });
  await prisma.aiAgent.create({
    data: {
      id: ids.agent,
      workspaceId,
      name: "Assistente Comercial IA",
      description: "Qualifica novos pedidos e prepara o handoff para vendas.",
      status: "active",
      providerMode: "prymeira_managed",
      provider: "simulated",
      model: "prymeira-simulated",
      systemPrompt: "Qualifique cidade, quantidade, prazo e pagamento. Resuma o contexto e solicite handoff para propostas.",
      behaviorConfig: { tone: "consultivo", language: "pt-BR" },
      handoffConfig: { afterQualification: true, confidenceThreshold: 0.6 },
      limitsConfig: { maxMessagesPerSession: 12 },
      allowedActions: ["send_message", "add_tag", "create_internal_note", "request_handoff"]
    }
  });
  await prisma.aiAgentAllowedTag.create({
    data: { workspaceId, agentId: ids.agent, tagId: tags[0].id }
  });
  await prisma.aiKnowledgeSource.create({
    data: {
      id: ids.knowledge,
      workspaceId,
      agentId: ids.agent,
      type: "faq",
      title: "Política comercial e entregas",
      content: "Atendemos empresas em todo o Sul. Propostas qualificadas recebem retorno do vendedor em até 15 minutos. Pagamento pode ser à vista ou faturado após análise.",
      status: "ready",
      metadata: { category: "comercial" }
    }
  });
  await prisma.quickReply.createMany({
    data: [
      {
        id: "90000000-0000-4000-8000-000000000001",
        workspaceId,
        title: "Proposta em preparação",
        category: "Vendas",
        body: "Perfeito! Já tenho os dados necessários e vou preparar sua proposta. Envio ainda hoje por aqui."
      },
      {
        id: "90000000-0000-4000-8000-000000000002",
        workspaceId,
        title: "Prazo de entrega",
        category: "Vendas",
        body: "Vou confirmar a disponibilidade e retorno com o melhor prazo de entrega."
      },
      {
        id: "90000000-0000-4000-8000-000000000003",
        workspaceId,
        title: "Follow-up",
        category: "Vendas",
        body: "Olá! Conseguiu avaliar nossa proposta? Posso ajustar algum item para avançarmos?"
      }
    ]
  });

  for (const seed of conversationSeeds()) {
    await prisma.contact.create({
      data: {
        id: seed.contactId,
        workspaceId,
        name: seed.name,
        phone: seed.phone,
        email: seed.email,
        company: seed.company,
        customFields: { origem: "WhatsApp", segmento: "B2B" }
      }
    });
    await prisma.contactBoardMembership.create({
      data: {
        workspaceId,
        contactId: seed.contactId,
        boardId: ids.board,
        stageId: stages[seed.stageOrder].id,
        isPrimary: true,
        lastMovedBy: "manual"
      }
    });
    const lastMessage = seed.messages.at(-1);
    await prisma.conversation.create({
      data: {
        id: seed.conversationId,
        workspaceId,
        channelId: ids.channel,
        contactId: seed.contactId,
        status: seed.status,
        assignedUserId: seed.assignedUserId,
        departmentId: seed.departmentId,
        lastMessageAt: lastMessage?.[2] ?? null,
        lastMessagePreview: lastMessage?.[1] ?? null,
        unreadCount: seed.unreadCount,
        priority: seed.priority
      }
    });
    for (const [index, [direction, body, createdAt]] of seed.messages.entries()) {
      await prisma.message.create({
        data: {
          workspaceId,
          conversationId: seed.conversationId,
          providerEventId: `demo:${seed.conversationId}:${index}`,
          providerMessageId: `demo-msg-${seed.conversationId}-${index}`,
          direction,
          type: "text",
          body,
          status: direction === "outbound" ? "sent" : "delivered",
          sentByUserId: direction === "outbound" ? seed.assignedUserId : null,
          createdAt
        }
      });
    }
    if (seed.tagIds.length > 0) {
      await prisma.conversationTag.createMany({
        data: seed.tagIds.map((tagId) => ({
          workspaceId,
          conversationId: seed.conversationId,
          tagId
        }))
      });
    }
  }

  await prisma.integrationConfig.create({
    data: {
      workspaceId,
      provider: "vincula",
      mode: "simulated",
      status: "configured",
      settings: { label: "Vincula CRM", fallbackEnabled: true }
    }
  });
  await prisma.crmSyncAction.createMany({
    data: [
      {
        workspaceId,
        contactId: "60000000-0000-4000-8000-000000000007",
        actionType: "create_lead",
        mode: "simulated",
        status: "completed",
        payload: { title: "Reposição mensal de materiais" },
        result: { vinculaLeadId: "lead-demo-1042", vinculaContactId: "contact-demo-207" }
      },
      {
        workspaceId,
        contactId: "60000000-0000-4000-8000-000000000008",
        actionType: "create_note",
        mode: "simulated",
        status: "completed",
        payload: { body: "Cliente validando condição com o financeiro." },
        result: { noteCreated: true, vinculaContactId: "contact-demo-231" }
      }
    ]
  });

  return {
    workspaceId,
    users: users.length,
    conversations: conversationSeeds().length,
    contacts: conversationSeeds().length,
    agents: 1
  };
}

async function simulateLead(
  prisma: PrismaClient,
  workspaceId: string,
  realtime?: DemoRealtime
): Promise<DemoLeadResult> {
  const conversation = await prisma.conversation.findUnique({
    where: { workspaceId_id: { workspaceId, id: ids.carlosConversation } },
    select: { id: true, status: true, activeAgentSessionId: true }
  });

  if (!conversation) {
    await seedWorkspace(prisma, workspaceId);
  }

  const created = conversation?.status !== "open" || !conversation.activeAgentSessionId;
  const now = new Date();
  const scriptedMessages: DemoMessage[] = [
    ["inbound", "Olá! Preciso de um orçamento de materiais para uma nova obra em Joinville.", new Date(now.getTime() - 5 * 60_000)],
    ["outbound", "Olá, Carlos! Para preparar o orçamento, qual a quantidade, o prazo e a forma de pagamento desejada?", new Date(now.getTime() - 4 * 60_000)],
    ["inbound", "São 120 unidades, preciso receber em até 15 dias e preferimos pagamento faturado.", new Date(now.getTime() - 3 * 60_000)],
    ["outbound", "Perfeito. Já qualifiquei sua solicitação e vou chamar um especialista para montar a proposta.", new Date(now.getTime() - 2 * 60_000)]
  ];

  await prisma.aiAgentPendingReply.deleteMany({ where: { workspaceId, conversationId: ids.carlosConversation } });
  await prisma.aiAgentRun.deleteMany({ where: { workspaceId, conversationId: ids.carlosConversation } });
  await prisma.aiAgentSession.deleteMany({ where: { workspaceId, conversationId: ids.carlosConversation } });
  await prisma.conversationTag.deleteMany({ where: { workspaceId, conversationId: ids.carlosConversation } });
  await prisma.message.deleteMany({ where: { workspaceId, conversationId: ids.carlosConversation } });
  await prisma.contactNote.deleteMany({ where: { workspaceId, conversationId: ids.carlosConversation } });

  await prisma.aiAgentSession.create({
    data: {
      id: ids.carlosSession,
      workspaceId,
      agentId: ids.agent,
      conversationId: ids.carlosConversation,
      status: "handoff_requested",
      messageCount: scriptedMessages.length,
      lastRunAt: now,
      handoffReason: "Qualificação concluída: cliente solicitou proposta comercial.",
      metadata: { demo: true, qualified: true }
    }
  });
  await prisma.conversation.update({
    where: { workspaceId_id: { workspaceId, id: ids.carlosConversation } },
    data: {
      status: "open",
      assignedUserId: null,
      departmentId: departments[0].id,
      lastMessageAt: scriptedMessages.at(-1)?.[2] ?? now,
      lastMessagePreview: scriptedMessages.at(-1)?.[1] ?? null,
      unreadCount: 1,
      priority: "high",
      aiControlStatus: "agent_allowed",
      aiControlUpdatedAt: now,
      aiControlUpdatedById: null,
      activeAgentSessionId: ids.carlosSession
    }
  });
  await prisma.conversationTag.create({
    data: { workspaceId, conversationId: ids.carlosConversation, tagId: tags[0].id }
  });
  await prisma.contactBoardMembership.update({
    where: {
      workspaceId_contactId_boardId: {
        workspaceId,
        contactId: ids.carlosContact,
        boardId: ids.board
      }
    },
    data: { stageId: stages[1].id, lastMovedBy: "rule", lastRuleAppliedAt: now }
  });
  await prisma.contactNote.create({
    data: {
      workspaceId,
      contactId: ids.carlosContact,
      conversationId: ids.carlosConversation,
      body: "Resumo da IA: Carlos busca 120 unidades para uma obra em Joinville, precisa receber em até 15 dias e prefere pagamento faturado. Próximo passo: elaborar proposta comercial.",
      createdById: null,
      createdAt: new Date(now.getTime() - 90_000)
    }
  });

  const createdMessages = [];
  for (const [index, [direction, body, createdAt]] of scriptedMessages.entries()) {
    createdMessages.push(await prisma.message.create({
      data: {
        workspaceId,
        conversationId: ids.carlosConversation,
        providerEventId: `demo-live:${ids.carlosConversation}:${index}`,
        providerMessageId: `demo-live-msg-${ids.carlosConversation}-${index}`,
        direction,
        type: "text",
        body,
        status: direction === "outbound" ? "sent" : "delivered",
        sentByUserId: null,
        createdAt
      }
    }));
  }
  await prisma.aiAgentRun.create({
    data: {
      workspaceId,
      agentId: ids.agent,
      sessionId: ids.carlosSession,
      conversationId: ids.carlosConversation,
      trigger: "automation",
      input: { message: scriptedMessages[2][1] },
      contextSummary: { city: "Joinville", quantity: 120, deadlineDays: 15, payment: "faturado" },
      knowledgeMatches: [{ sourceId: ids.knowledge, title: "Política comercial e entregas" }],
      output: { summaryCreated: true, tagApplied: "Orçamento quente", handoffRequested: true },
      actions: ["add_tag", "create_internal_note", "request_handoff"],
      status: "handoff_requested",
      model: "prymeira-simulated",
      confidence: 0.94,
      costEstimate: { mode: "simulated", value: 0 }
    }
  });

  if (realtime) {
    for (const message of createdMessages) {
      realtime.publish({ type: "message.created", workspaceId, payload: toMessageDto(message) });
    }
    const updatedConversation = await prisma.conversation.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId, id: ids.carlosConversation } },
      include: {
        contact: { select: { name: true, phone: true } },
        channel: { select: { displayName: true, phoneNumber: true, provider: true } },
        department: { select: { name: true } },
        assignedUser: { select: { displayName: true } },
        activeAgentSession: {
          select: {
            status: true,
            handoffReason: true,
            agent: { select: { name: true } }
          }
        }
      }
    });
    realtime.publish({
      type: "conversation.updated",
      workspaceId,
      payload: toConversationDto(updatedConversation)
    });
  }

  return {
    workspaceId,
    conversationId: ids.carlosConversation,
    contactId: ids.carlosContact,
    created
  };
}

export function createDemoScenarioService(prisma: PrismaClient, realtime?: DemoRealtime) {
  return {
    reset(workspaceId: string) {
      return seedWorkspace(prisma, workspaceId);
    },
    simulateLead(workspaceId: string) {
      return simulateLead(prisma, workspaceId, realtime);
    }
  };
}

export type DemoScenarioService = ReturnType<typeof createDemoScenarioService>;
