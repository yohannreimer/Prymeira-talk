import type { PrismaClient } from '@prisma/client';
import type { EvolutionHistorySource } from '../evolution/evolution-history.js';
import { buildPhoneLookupCandidates } from '../contacts/phone-normalization.js';
import { usableContactName } from '../contacts/contact-name.js';
import { contactIdentity } from './channel-history-import.js';

const PAGE_SIZE = 2000;

export type ContactNameRecoveryResult = {
  dryRun: boolean;
  channelsChecked: number;
  failedChannels: number;
  /** Non-group contacts without a usable name (null, "Você", their own number, a raw WhatsApp id). */
  candidates: number;
  /** Candidates that got (or, in a dry run, would get) their real WhatsApp name. */
  recovered: number;
  /** Invalid names set (or, in a dry run, that would be set) to null because no real name was found. */
  cleared: number;
  /** Candidates left as they were: null with no real name, or a write that lost a race or failed. */
  skipped: number;
};

type Candidate = { id: string; phone: string; name: string | null; updatedAt: Date };

/**
 * Repairs contacts whose stored name is not a real name. The real WhatsApp profile name comes from
 * Evolution's contact list; an invalid name with no real match is cleared so the UI shows the number.
 * Contacts with a usable name are never written. Nothing is written when no channel answered.
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

  async function write(workspaceId: string, contact: Candidate, name: string | null) {
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
      dryRun?: boolean;
    }): Promise<ContactNameRecoveryResult> {
      const dryRun = params.dryRun ?? false;
      const { names, failed } = await realNames(params.channels);
      const result: ContactNameRecoveryResult = {
        dryRun, channelsChecked: params.channels.length, failedChannels: failed,
        candidates: 0, recovered: 0, cleared: 0, skipped: 0
      };
      // Without a single answering channel there is no source of truth: never recover or clear.
      if (failed === params.channels.length) return result;
      let after: string | undefined;
      for (;;) {
        // Full keyset scan: "usable" folds case, accents and punctuation, which a SQL pre-filter cannot
        // express exactly. Pages are small and only the columns needed for the check are selected.
        const page = await input.prisma.contact.findMany({
          where: { workspaceId: params.workspaceId, isGroup: false, ...(after ? { id: { gt: after } } : {}) },
          select: { id: true, phone: true, name: true, updatedAt: true },
          orderBy: { id: 'asc' },
          take: PAGE_SIZE
        });
        for (const contact of page) {
          if (contact.name !== null && usableContactName(contact.name)) continue;
          result.candidates++;
          const realName = findRealName(names, contact.phone);
          if (!realName && contact.name === null) {
            result.skipped++;
            continue;
          }
          if (!dryRun && !(await write(params.workspaceId, contact, realName))) {
            result.skipped++;
            continue;
          }
          if (realName) result.recovered++;
          else result.cleared++;
        }
        if (page.length < PAGE_SIZE) break;
        after = page[page.length - 1]!.id;
      }
      return result;
    }
  };
}

export type ContactNameRecovery = ReturnType<typeof createContactNameRecovery>;
