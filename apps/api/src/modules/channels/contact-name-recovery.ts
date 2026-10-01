import type { PrismaClient } from '@prisma/client';
import type { EvolutionHistorySource } from '../evolution/evolution-history.js';
import { buildPhoneLookupCandidates } from '../contacts/phone-normalization.js';
import { usableContactName } from '../contacts/contact-name.js';
import { contactIdentity } from './channel-history-import.js';

const PAGE_SIZE = 2000;

export type ContactNameRecoveryResult = {
  dryRun: boolean;
  channelsChecked: number;
  invalid: number;
  recoverable: number;
  recovered: number;
  cleared: number;
  failedChannels: number;
};

/**
 * Repairs contacts whose stored name is not a real name ("Você", their own number, a raw WhatsApp id).
 * The real WhatsApp profile name is taken from Evolution's contact list; when none exists the name is
 * cleared, but only when at least one channel answered (never clear without a source of truth).
 */
export function createContactNameRecovery(input: {
  prisma: Pick<PrismaClient, 'contact'>;
  source: Pick<EvolutionHistorySource, 'recentContacts'>;
}) {
  async function realNames(channels: Array<{ providerKey: string }>) {
    const names = new Map<string, string>();
    let failed = 0;
    for (const channel of channels) {
      try {
        for (const item of await input.source.recentContacts({ instanceName: channel.providerKey })) {
          const name = usableContactName(item.name);
          const identity = contactIdentity(item.phoneJid);
          if (name && identity && !names.has(identity)) names.set(identity, name);
        }
      } catch {
        failed++;
      }
    }
    return { names, failed };
  }

  function findRealName(names: Map<string, string>, phone: string) {
    const identity = contactIdentity(phone);
    const candidates = identity.endsWith('@lid') ? [identity] : buildPhoneLookupCandidates(identity);
    for (const candidate of candidates) {
      const name = names.get(candidate);
      if (name) return name;
    }
    return null;
  }

  async function write(workspaceId: string, contact: { id: string; name: string; updatedAt: Date }, name: string | null) {
    try {
      const result = await input.prisma.contact.updateMany({
        // Conditional on the old name so a concurrent rename is never overwritten; updatedAt is kept so
        // the repair does not reorder contacts.
        where: { id: contact.id, workspaceId, name: contact.name },
        data: { name, updatedAt: contact.updatedAt }
      });
      return result.count > 0;
    } catch {
      return false;
    }
  }

  return {
    async recover(params: {
      workspaceId: string;
      channels: Array<{ id: string; providerKey: string }>;
      dryRun: boolean;
    }): Promise<ContactNameRecoveryResult> {
      const { names, failed } = await realNames(params.channels);
      const canClear = failed < params.channels.length;
      const result: ContactNameRecoveryResult = {
        dryRun: params.dryRun, channelsChecked: params.channels.length,
        invalid: 0, recoverable: 0, recovered: 0, cleared: 0, failedChannels: failed
      };
      let after: string | undefined;
      for (;;) {
        const page = await input.prisma.contact.findMany({
          where: { workspaceId: params.workspaceId, isGroup: false, name: { not: null }, ...(after ? { id: { gt: after } } : {}) },
          select: { id: true, phone: true, name: true, updatedAt: true },
          orderBy: { id: 'asc' },
          take: PAGE_SIZE
        });
        for (const contact of page) {
          if (contact.name === null || usableContactName(contact.name)) continue;
          result.invalid++;
          const realName = findRealName(names, contact.phone);
          if (realName) result.recoverable++;
          if (params.dryRun || (!realName && !canClear)) continue;
          if (await write(params.workspaceId, { id: contact.id, name: contact.name, updatedAt: contact.updatedAt }, realName)) {
            if (realName) result.recovered++;
            else result.cleared++;
          }
        }
        if (page.length < PAGE_SIZE) break;
        after = page[page.length - 1]!.id;
      }
      return result;
    }
  };
}

export type ContactNameRecovery = ReturnType<typeof createContactNameRecovery>;
