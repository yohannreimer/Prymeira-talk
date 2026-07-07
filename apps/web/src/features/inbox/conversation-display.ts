import type { ConversationDto } from "@prymeira-talk/shared";

export type ChannelFilterOption = {
  id: "all" | string;
  label: string;
};

export type ConversationQueueFilter = "active" | "closed" | "all";

export function contactDisplayName(conversation: ConversationDto) {
  return conversation.contactName ?? conversation.contactPhone ?? `Contato ${conversation.contactId.slice(0, 8)}`;
}

export function getChannelFilterOptions(conversations: ConversationDto[]): ChannelFilterOption[] {
  const options: ChannelFilterOption[] = [{ id: "all", label: "Todos" }];
  const seenChannelIds = new Set<string>();

  for (const conversation of conversations) {
    if (seenChannelIds.has(conversation.channelId)) continue;

    seenChannelIds.add(conversation.channelId);
    options.push({
      id: conversation.channelId,
      label: conversation.channelName ?? `Canal ${conversation.channelId.slice(0, 8)}`
    });
  }

  return options;
}

export function filterConversationsByChannel(
  conversations: ConversationDto[],
  selectedChannelId: string
) {
  if (selectedChannelId === "all") return conversations;

  return conversations.filter((conversation) => conversation.channelId === selectedChannelId);
}

export function filterConversationsByQueue(
  conversations: ConversationDto[],
  selectedQueue: ConversationQueueFilter
) {
  if (selectedQueue === "all") return conversations;
  if (selectedQueue === "closed") {
    return conversations.filter((conversation) => conversation.status === "closed");
  }

  return conversations.filter((conversation) => conversation.status !== "closed");
}
