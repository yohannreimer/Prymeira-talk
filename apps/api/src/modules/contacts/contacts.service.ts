import type { PrismaClient } from "@prisma/client";
import type { ContactDto, ConversationDto } from "@prymeira-talk/shared";
import {
  toConversationDto,
  type ConversationRecord
} from "../conversations/conversations.service.js";
import {
  buildPhoneLookupCandidates,
  normalizePhoneForStorage
} from "./phone-normalization.js";

type DateLike = Date | string;

interface ContactRecord {
  id: string;
  workspaceId: string;
  name: string | null;
  phone: string;
  email: string | null;
  company: string | null;
  avatarUrl?: string | null;
  customFields?: unknown;
  atomicCrmContactId: string | null;
  atomicCrmLeadId: string | null;
  createdAt: DateLike;
  updatedAt: DateLike;
}

type ContactFindManyArgs = Parameters<PrismaClient["contact"]["findMany"]>[0];
type ContactCreateArgs = Parameters<PrismaClient["contact"]["create"]>[0];
type ContactUpdateArgs = Parameters<PrismaClient["contact"]["update"]>[0];
type ContactFindUniqueArgs = Parameters<PrismaClient["contact"]["findUnique"]>[0];
type ContactFindFirstArgs = Parameters<PrismaClient["contact"]["findFirst"]>[0];
type ChannelFindFirstArgs = Parameters<PrismaClient["channel"]["findFirst"]>[0];
type ConversationUpsertArgs = Parameters<PrismaClient["conversation"]["upsert"]>[0];

export interface PrismaLike {
  contact: {
    findMany(args: ContactFindManyArgs): Promise<ContactRecord[]>;
    create(args: ContactCreateArgs): Promise<ContactRecord>;
    update(args: ContactUpdateArgs): Promise<ContactRecord>;
    findUnique(args: ContactFindUniqueArgs): Promise<{ id: string } | null>;
    findFirst(args: ContactFindFirstArgs): Promise<ContactRecord | null>;
  };
  channel: {
    findFirst(args: ChannelFindFirstArgs): Promise<{ id: string } | null>;
  };
  conversation: {
    upsert(args: ConversationUpsertArgs): Promise<unknown>;
  };
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeRequired(value: string) {
  return normalizePhoneForStorage(value);
}

function normalizeOptional(value: string | undefined) {
  if (value === undefined) return undefined;

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as T;
}

export function toContactDto(record: ContactRecord): ContactDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    phone: record.phone,
    email: record.email,
    company: record.company,
    atomicCrmContactId: record.atomicCrmContactId,
    atomicCrmLeadId: record.atomicCrmLeadId,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

export function createContactsService(prisma: PrismaLike) {
  async function findContactByPhoneVariant(workspaceId: string, phone: string) {
    return prisma.contact.findFirst({
      where: {
        workspaceId,
        phone: { in: buildPhoneLookupCandidates(phone) }
      },
      orderBy: { updatedAt: "desc" }
    });
  }

  return {
    async listContacts(input: {
      workspaceId: string;
      search?: string;
    }): Promise<ContactDto[]> {
      const search = input.search?.trim();
      const contacts = await prisma.contact.findMany({
        where: search
          ? {
              workspaceId: input.workspaceId,
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { company: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
                { phone: { contains: search, mode: "insensitive" } }
              ]
            }
          : { workspaceId: input.workspaceId },
        orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
        take: 100
      });

      return contacts.map(toContactDto);
    },

    async createContact(input: {
      workspaceId: string;
      name?: string;
      phone: string;
      email?: string;
      company?: string;
    }): Promise<ContactDto> {
      const data = {
        name: normalizeOptional(input.name) ?? null,
        phone: normalizeRequired(input.phone),
        email: normalizeOptional(input.email) ?? null,
        company: normalizeOptional(input.company) ?? null
      };
      const existingContact = await findContactByPhoneVariant(input.workspaceId, input.phone);
      const contact = existingContact
        ? await prisma.contact.update({
            where: {
              workspaceId_id: {
                workspaceId: input.workspaceId,
                id: existingContact.id
              }
            },
            data
          })
        : await prisma.contact.create({
            data: {
              workspaceId: input.workspaceId,
              ...data
            }
          });

      return toContactDto(contact);
    },

    async updateContact(input: {
      workspaceId: string;
      contactId: string;
      name?: string;
      phone?: string;
      email?: string;
      company?: string;
    }): Promise<ContactDto> {
      const contact = await prisma.contact.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.contactId
          }
        },
        data: withoutUndefined({
          name: normalizeOptional(input.name),
          phone: input.phone === undefined ? undefined : normalizeRequired(input.phone),
          email: normalizeOptional(input.email),
          company: normalizeOptional(input.company)
        })
      });

      return toContactDto(contact);
    },

    async startConversation(input: {
      workspaceId: string;
      contactId: string;
      channelId: string;
    }): Promise<ConversationDto> {
      const [contact, channel] = await Promise.all([
        prisma.contact.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.contactId
            }
          },
          select: { id: true }
        }),
        prisma.channel.findFirst({
          where: {
            workspaceId: input.workspaceId,
            id: input.channelId,
            provider: "evolution"
          },
          select: { id: true }
        })
      ]);

      if (!contact) {
        throw new Error("CONTACT_NOT_FOUND");
      }

      if (!channel) {
        throw new Error("CHANNEL_NOT_FOUND");
      }

      const conversation = await prisma.conversation.upsert({
        where: {
          workspaceId_channelId_contactId: {
            workspaceId: input.workspaceId,
            channelId: input.channelId,
            contactId: input.contactId
          }
        },
        create: {
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          contactId: input.contactId,
          status: "open"
        },
        update: {
          status: "open"
        },
        include: {
          assignedUser: { select: { displayName: true } },
          channel: { select: { displayName: true, phoneNumber: true } },
          contact: { select: { name: true, phone: true } },
          department: { select: { name: true } }
        }
      });

      return toConversationDto(conversation as ConversationRecord);
    }
  };
}
