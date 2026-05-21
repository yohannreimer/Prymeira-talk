import { PrismaClient } from "@prisma/client";
import type { MessageDirection } from "@prisma/client";

const prisma = new PrismaClient();
const workspaceId = process.env.PRYMEIRA_LOCAL_WORKSPACE_ID ?? "local_workspace";
type DemoMessage = [MessageDirection, string, Date];

const channelId = "10000000-0000-4000-8000-000000000001";

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
    presenceState: "away"
  }
];

const departments = [
  { id: "30000000-0000-4000-8000-000000000001", name: "Vendas", routingOrder: 1 },
  { id: "30000000-0000-4000-8000-000000000002", name: "Suporte", routingOrder: 2 },
  { id: "30000000-0000-4000-8000-000000000003", name: "Financeiro", routingOrder: 3 }
];

const tags = [
  { id: "40000000-0000-4000-8000-000000000001", name: "Quente", color: "#d9534f" },
  { id: "40000000-0000-4000-8000-000000000002", name: "Renovacao", color: "#24564a" },
  { id: "40000000-0000-4000-8000-000000000003", name: "Suporte", color: "#4f6f9f" }
];

const preSalesBoard = {
  id: "70000000-0000-4000-8000-000000000001",
  name: "Pre-vendas",
  description: "Board principal para contatos comerciais."
};

const preSalesStages = [
  { id: "71000000-0000-4000-8000-000000000001", name: "Novo", order: 0, color: "#E8F1FF" },
  { id: "71000000-0000-4000-8000-000000000002", name: "Qualificado", order: 1, color: "#E7F6ED" },
  { id: "71000000-0000-4000-8000-000000000003", name: "Proposta enviada", order: 2, color: "#FFF3D9" },
  { id: "71000000-0000-4000-8000-000000000004", name: "Follow-up", order: 3, color: "#F3E8FF" },
  { id: "71000000-0000-4000-8000-000000000005", name: "Ganho", order: 4, color: "#DFF3EA" }
];

const demoConversations = [
  {
    conversationId: "50000000-0000-4000-8000-000000000001",
    contactId: "60000000-0000-4000-8000-000000000001",
    name: "Ana Beatriz",
    phone: "5547999910101",
    company: "Clínica Aurora",
    status: "open" as const,
    priority: "high" as const,
    unreadCount: 3,
    departmentId: departments[0].id,
    assignedUserId: users[0].id,
    tags: [tags[0].id],
    lastMessageAt: minutesAgo(4),
    messages: [
      ["inbound", "Oi, vi o anúncio e queria entender os planos para três atendentes.", minutesAgo(18)],
      ["outbound", "Claro, Ana. Para três atendentes eu recomendo começar no plano Operação.", minutesAgo(12)],
      ["inbound", "Consegue me mandar os valores e como funciona a integração com WhatsApp?", minutesAgo(4)]
    ] satisfies DemoMessage[]
  },
  {
    conversationId: "50000000-0000-4000-8000-000000000002",
    contactId: "60000000-0000-4000-8000-000000000002",
    name: "João Martins",
    phone: "5551999820202",
    company: "JM Auto Peças",
    status: "pending" as const,
    priority: "normal" as const,
    unreadCount: 1,
    departmentId: departments[1].id,
    assignedUserId: users[1].id,
    tags: [tags[2].id],
    lastMessageAt: minutesAgo(27),
    messages: [
      ["inbound", "Meu QR caiu de novo depois que reiniciei o celular.", minutesAgo(49)],
      ["outbound", "Vou conferir a sessão da Evolution e te aviso em seguida.", minutesAgo(35)],
      ["inbound", "Perfeito, estou aguardando.", minutesAgo(27)]
    ] satisfies DemoMessage[]
  },
  {
    conversationId: "50000000-0000-4000-8000-000000000003",
    contactId: "60000000-0000-4000-8000-000000000003",
    name: "Camila Rocha",
    phone: "5511999730303",
    company: "Studio Rocha",
    status: "open" as const,
    priority: "high" as const,
    unreadCount: 2,
    departmentId: departments[0].id,
    assignedUserId: users[2].id,
    tags: [tags[0].id],
    lastMessageAt: minutesAgo(58),
    messages: [
      ["inbound", "Quero migrar de uma ferramenta parecida, mas não posso perder as etiquetas.", minutesAgo(82)],
      ["outbound", "Dá para importar as etiquetas e manter o histórico principal.", minutesAgo(74)],
      ["inbound", "Então vamos marcar uma call ainda hoje?", minutesAgo(58)]
    ] satisfies DemoMessage[]
  },
  {
    conversationId: "50000000-0000-4000-8000-000000000004",
    contactId: "60000000-0000-4000-8000-000000000004",
    name: "Pedro Almeida",
    phone: "5548999640404",
    company: "Almeida Energia",
    status: "closed" as const,
    priority: "low" as const,
    unreadCount: 0,
    departmentId: departments[2].id,
    assignedUserId: users[1].id,
    tags: [tags[1].id],
    lastMessageAt: hoursAgo(3),
    messages: [
      ["inbound", "Recebi a segunda via, obrigado.", hoursAgo(4)],
      ["outbound", "Boa, Pedro. Fechei o atendimento por aqui.", hoursAgo(3)]
    ] satisfies DemoMessage[]
  },
  {
    conversationId: "50000000-0000-4000-8000-000000000005",
    contactId: "60000000-0000-4000-8000-000000000005",
    name: "Larissa Gomes",
    phone: "5531999550505",
    company: "Gomes Moda",
    status: "open" as const,
    priority: "normal" as const,
    unreadCount: 0,
    departmentId: departments[0].id,
    assignedUserId: null,
    tags: [],
    lastMessageAt: hoursAgo(6),
    messages: [
      ["inbound", "Vocês têm automação para carrinho abandonado pelo WhatsApp?", hoursAgo(7)],
      ["outbound", "Temos sim. A próxima etapa é ligar o fluxo visual de automações.", hoursAgo(6)]
    ] satisfies DemoMessage[]
  }
];

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function hoursAgo(hours: number) {
  return minutesAgo(hours * 60);
}

async function main() {
  await prisma.workspaceMirror.upsert({
    where: { workspaceId },
    update: {
      name: "Prymeira Demo",
      plan: "local",
      limits: { conversations: 50, agents: 5 }
    },
    create: {
      workspaceId,
      name: "Prymeira Demo",
      plan: "local",
      limits: { conversations: 50, agents: 5 }
    }
  });

  for (const user of users) {
    await prisma.userProfile.upsert({
      where: { workspaceId_clerkUserId: { workspaceId, clerkUserId: user.clerkUserId } },
      update: user,
      create: { ...user, workspaceId }
    });
  }

  for (const department of departments) {
    await prisma.department.upsert({
      where: { workspaceId_name: { workspaceId, name: department.name } },
      update: department,
      create: { ...department, workspaceId }
    });
  }

  await prisma.channel.upsert({
    where: {
      workspaceId_provider_providerKey: {
        workspaceId,
        provider: "evolution",
        providerKey: "demo-evolution"
      }
    },
    update: {
      displayName: "WhatsApp Comercial",
      phoneNumber: "+55 47 99999-0000",
      status: "connected"
    },
    create: {
      id: channelId,
      workspaceId,
      provider: "evolution",
      providerKey: "demo-evolution",
      displayName: "WhatsApp Comercial",
      phoneNumber: "+55 47 99999-0000",
      status: "connected"
    }
  });

  for (const tag of tags) {
    await prisma.tag.upsert({
      where: { workspaceId_name: { workspaceId, name: tag.name } },
      update: tag,
      create: { ...tag, workspaceId }
    });
  }

  const board = await prisma.contactBoard.upsert({
    where: { workspaceId_name: { workspaceId, name: preSalesBoard.name } },
    update: {
      description: preSalesBoard.description
    },
    create: {
      ...preSalesBoard,
      workspaceId
    }
  });

  const stageByOrder = new Map<number, string>();
  for (const stage of preSalesStages) {
    const persistedStage = await prisma.contactBoardStage.upsert({
      where: {
        workspaceId_boardId_name: {
          workspaceId,
          boardId: board.id,
          name: stage.name
        }
      },
      update: {
        color: stage.color,
        order: stage.order
      },
      create: {
        ...stage,
        workspaceId,
        boardId: board.id
      }
    });
    stageByOrder.set(stage.order, persistedStage.id);
  }

  for (const item of demoConversations) {
    await prisma.contact.upsert({
      where: { workspaceId_phone: { workspaceId, phone: item.phone } },
      update: {
        name: item.name,
        company: item.company
      },
      create: {
        id: item.contactId,
        workspaceId,
        name: item.name,
        phone: item.phone,
        company: item.company
      }
    });

    const stageId = stageByOrder.get(Math.min(stageByOrder.size - 1, item.tags.length + item.unreadCount));
    if (stageId) {
      await prisma.contactBoardMembership.upsert({
        where: {
          workspaceId_contactId_boardId: {
            workspaceId,
            contactId: item.contactId,
            boardId: board.id
          }
        },
        update: {
          stageId,
          isPrimary: true
        },
        create: {
          workspaceId,
          contactId: item.contactId,
          boardId: board.id,
          stageId,
          isPrimary: true
        }
      });
    }

    await prisma.conversation.upsert({
      where: {
        workspaceId_channelId_contactId: {
          workspaceId,
          channelId,
          contactId: item.contactId
        }
      },
      update: {
        status: item.status,
        assignedUserId: item.assignedUserId,
        departmentId: item.departmentId,
        lastMessageAt: item.lastMessageAt,
        lastMessagePreview: item.messages.at(-1)?.[1] ?? null,
        unreadCount: item.unreadCount,
        priority: item.priority
      },
      create: {
        id: item.conversationId,
        workspaceId,
        channelId,
        contactId: item.contactId,
        status: item.status,
        assignedUserId: item.assignedUserId,
        departmentId: item.departmentId,
        lastMessageAt: item.lastMessageAt,
        lastMessagePreview: item.messages.at(-1)?.[1] ?? null,
        unreadCount: item.unreadCount,
        priority: item.priority
      }
    });

    await prisma.message.deleteMany({
      where: {
        workspaceId,
        conversationId: item.conversationId
      }
    });

    for (const [index, message] of item.messages.entries()) {
      const [direction, body, createdAt] = message;
      await prisma.message.create({
        data: {
          workspaceId,
          conversationId: item.conversationId,
          providerEventId: `demo:${item.conversationId}:${index}`,
          providerMessageId: `demo-msg-${item.conversationId}-${index}`,
          direction,
          type: "text",
          body,
          status: direction === "outbound" ? "sent" : "delivered",
          sentByUserId: direction === "outbound" ? item.assignedUserId : null,
          createdAt
        }
      });
    }

    for (const tagId of item.tags) {
      await prisma.conversationTag.upsert({
        where: {
          workspaceId_conversationId_tagId: {
            workspaceId,
            conversationId: item.conversationId,
            tagId
          }
        },
        update: {},
        create: {
          workspaceId,
          conversationId: item.conversationId,
          tagId
        }
      });
    }
  }

  console.log(`Seeded ${demoConversations.length} demo conversations for ${workspaceId}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
