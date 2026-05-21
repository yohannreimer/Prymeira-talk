import type { PrismaClient } from "@prisma/client";
import type { ContactDto } from "@prymeira-talk/shared";

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

export interface PrismaLike {
  contact: {
    findMany(args: ContactFindManyArgs): Promise<ContactRecord[]>;
    create(args: ContactCreateArgs): Promise<ContactRecord>;
    update(args: ContactUpdateArgs): Promise<ContactRecord>;
    findUnique(args: ContactFindUniqueArgs): Promise<{ id: string } | null>;
  };
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeRequired(value: string) {
  return value.trim();
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
      const contact = await prisma.contact.create({
        data: {
          workspaceId: input.workspaceId,
          name: normalizeOptional(input.name) ?? null,
          phone: normalizeRequired(input.phone),
          email: normalizeOptional(input.email) ?? null,
          company: normalizeOptional(input.company) ?? null
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
    }
  };
}
