import type { ChannelDto } from '@prymeira-talk/shared';

type ChannelRecord = Pick<ChannelDto, 'id' | 'workspaceId' | 'provider' | 'providerKey' | 'phoneNumber' | 'displayName' | 'status'> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  archivedAt?: Date | string | null;
};

/** Legacy logical contract, shared without a service-to-service import cycle. */
export function toChannelDto(record: ChannelRecord): ChannelDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    provider: record.provider,
    providerKey: record.providerKey,
    phoneNumber: record.phoneNumber,
    displayName: record.displayName,
    status: record.status,
    archivedAt: record.archivedAt ? (record.archivedAt instanceof Date ? record.archivedAt.toISOString() : record.archivedAt) : null,
    createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : record.updatedAt
  };
}
