import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const workspaceId = process.env.PRYMEIRA_LOCAL_WORKSPACE_ID ?? "local_workspace";

// Extra contacts beyond the 5 already seeded
const extraContacts = [
  { id: "60000000-0000-4000-8000-000000000006", name: "Fernanda Lima",    phone: "5511999660606", company: "Lima Eventos",       email: "fernanda@limaeventos.com" },
  { id: "60000000-0000-4000-8000-000000000007", name: "Roberto Farias",   phone: "5521999770707", company: "Farias Construções",  email: "roberto@farias.com.br" },
  { id: "60000000-0000-4000-8000-000000000008", name: "Juliana Mendes",   phone: "5562999880808", company: "Studio JM",           email: "ju@studiojm.com" },
  { id: "60000000-0000-4000-8000-000000000009", name: "Marcos Teixeira",  phone: "5531999990909", company: "Teixeira & Filhos",   email: null },
  { id: "60000000-0000-4000-8000-000000000010", name: "Patricia Souza",   phone: "5547988881010", company: "Pet Shop Aurora",     email: "patricia@petauror.com" },
  { id: "60000000-0000-4000-8000-000000000011", name: "Eduardo Carvalho", phone: "5516977771111", company: "Carvalho Advocacia",  email: "eduardo@carvalholaw.com" },
  { id: "60000000-0000-4000-8000-000000000012", name: "Isabela Nunes",    phone: "5551966661212", company: "Nunes Nutrição",      email: "isa@nutricaonunes.com" },
  { id: "60000000-0000-4000-8000-000000000013", name: "Thiago Barbosa",   phone: "5581955551313", company: "TBarbosa Tech",       email: null },
];

// Demo campaigns
const campaigns = [
  {
    id: "80000000-0000-4000-8000-000000000001",
    name: "Promoção de Inverno 2025",
    status: "completed" as const,
    messageBody: "Olá {{nome}}! Temos uma oferta especial de inverno para você. Válida até 31/07. Acesse agora: https://prymeira.com/promo",
    scheduledAt: new Date("2025-07-10T09:00:00"),
    recipients: [
      { contactId: "60000000-0000-4000-8000-000000000001", status: "sent",      sentAt: new Date("2025-07-10T09:01:00") },
      { contactId: "60000000-0000-4000-8000-000000000002", status: "sent",      sentAt: new Date("2025-07-10T09:01:00") },
      { contactId: "60000000-0000-4000-8000-000000000003", status: "sent",      sentAt: new Date("2025-07-10T09:01:00") },
      { contactId: "60000000-0000-4000-8000-000000000006", status: "sent",      sentAt: new Date("2025-07-10T09:01:00") },
      { contactId: "60000000-0000-4000-8000-000000000007", status: "sent",      sentAt: new Date("2025-07-10T09:01:00") },
      { contactId: "60000000-0000-4000-8000-000000000008", status: "sent",      sentAt: new Date("2025-07-10T09:01:00") },
      { contactId: "60000000-0000-4000-8000-000000000009", status: "failed",    sentAt: null },
      { contactId: "60000000-0000-4000-8000-000000000010", status: "sent",      sentAt: new Date("2025-07-10T09:02:00") },
    ],
  },
  {
    id: "80000000-0000-4000-8000-000000000002",
    name: "Reativação Clientes Inativos",
    status: "completed" as const,
    messageBody: "Sentimos sua falta, {{nome}}! Que tal uma conversa? Nosso time está pronto para te atender.",
    scheduledAt: new Date("2025-08-01T14:00:00"),
    recipients: [
      { contactId: "60000000-0000-4000-8000-000000000004", status: "sent",   sentAt: new Date("2025-08-01T14:01:00") },
      { contactId: "60000000-0000-4000-8000-000000000005", status: "sent",   sentAt: new Date("2025-08-01T14:01:00") },
      { contactId: "60000000-0000-4000-8000-000000000011", status: "sent",   sentAt: new Date("2025-08-01T14:02:00") },
      { contactId: "60000000-0000-4000-8000-000000000012", status: "sent",   sentAt: new Date("2025-08-01T14:02:00") },
      { contactId: "60000000-0000-4000-8000-000000000013", status: "failed", sentAt: null },
    ],
  },
  {
    id: "80000000-0000-4000-8000-000000000003",
    name: "Lançamento Novo Plano Premium",
    status: "scheduled" as const,
    messageBody: "{{nome}}, temos novidade! Nosso novo plano Premium chegou com recursos incríveis. Quer saber mais?",
    scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // 2 days from now
    recipients: [
      { contactId: "60000000-0000-4000-8000-000000000001", status: "pending", sentAt: null },
      { contactId: "60000000-0000-4000-8000-000000000002", status: "pending", sentAt: null },
      { contactId: "60000000-0000-4000-8000-000000000003", status: "pending", sentAt: null },
      { contactId: "60000000-0000-4000-8000-000000000006", status: "pending", sentAt: null },
      { contactId: "60000000-0000-4000-8000-000000000007", status: "pending", sentAt: null },
      { contactId: "60000000-0000-4000-8000-000000000008", status: "pending", sentAt: null },
      { contactId: "60000000-0000-4000-8000-000000000010", status: "pending", sentAt: null },
      { contactId: "60000000-0000-4000-8000-000000000011", status: "pending", sentAt: null },
      { contactId: "60000000-0000-4000-8000-000000000012", status: "pending", sentAt: null },
    ],
  },
];

async function main() {
  // Upsert extra contacts
  for (const contact of extraContacts) {
    await prisma.contact.upsert({
      where: { workspaceId_phone: { workspaceId, phone: contact.phone } },
      update: { name: contact.name, company: contact.company, email: contact.email },
      create: { ...contact, workspaceId },
    });
  }
  console.log(`✓ ${extraContacts.length} extra contacts upserted`);

  // Upsert campaigns + recipients (raw to avoid schema/db column drift)
  for (const campaign of campaigns) {
    await prisma.$executeRaw`
      INSERT INTO campaigns (id, workspace_id, name, status, message_body, audience, scheduled_at, created_at, updated_at)
      VALUES (
        ${campaign.id}::uuid,
        ${workspaceId},
        ${campaign.name},
        ${campaign.status}::"CampaignStatus",
        ${campaign.messageBody},
        '{}'::jsonb,
        ${campaign.scheduledAt},
        NOW(),
        NOW()
      )
      ON CONFLICT (workspace_id, id) DO UPDATE
        SET name = EXCLUDED.name,
            status = EXCLUDED.status,
            scheduled_at = EXCLUDED.scheduled_at,
            updated_at = NOW()
    `;

    // Delete and re-insert recipients for idempotency (raw — avoid schema/db drift)
    await prisma.$executeRaw`DELETE FROM campaign_recipients WHERE workspace_id = ${workspaceId} AND campaign_id = ${campaign.id}::uuid`;
    for (const r of campaign.recipients) {
      await prisma.$executeRaw`
        INSERT INTO campaign_recipients (id, workspace_id, campaign_id, contact_id, status, result, created_at, updated_at)
        VALUES (gen_random_uuid(), ${workspaceId}, ${campaign.id}::uuid, ${r.contactId}::uuid, ${r.status}, '{}'::jsonb, NOW(), NOW())
      `;
    }
    console.log(`✓ Campaign "${campaign.name}" (${campaign.recipients.length} recipients)`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
