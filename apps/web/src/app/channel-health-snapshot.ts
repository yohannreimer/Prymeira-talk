import type { ChannelHealthDto, ChannelWatchdogStatusDto } from '@prymeira-talk/shared';

export type ChannelHealthSnapshot = { health: ChannelHealthDto[]; watchdog: ChannelWatchdogStatusDto };

export const defaultWatchdogStatus: ChannelWatchdogStatusDto = { enabled: false, lastTickAt: null, lastTickOk: true, lastError: null, unreachable: false };
