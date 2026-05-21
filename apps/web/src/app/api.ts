import {
  contactBoardMembershipSchema,
  contactBoardSchema,
  contactBoardStageSchema,
  channelOperationResultSchema,
  channelQrResultSchema,
  channelSchema,
  channelTestInboundResultSchema,
  contactSchema,
  conversationSchema,
  messageSchema,
  type ChannelDto,
  type ChannelOperationResultDto,
  type ChannelQrResultDto,
  type ChannelTestInboundResultDto,
  type ContactBoardDto,
  type ContactBoardMembershipDto,
  type ContactBoardStageDto,
  type ContactDto,
  type ConversationDto,
  type MessageDto
} from "@prymeira-talk/shared";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3002";

export interface ContactBoardWithStagesDto extends ContactBoardDto {
  stages: ContactBoardStageDto[];
}

export interface BoardContactCardDto extends ContactBoardMembershipDto {
  contact: ContactDto;
}

export interface BoardContactsDto {
  board: ContactBoardDto;
  stages: ContactBoardStageDto[];
  memberships: BoardContactCardDto[];
}

export interface ContactContextDto {
  primaryBoardStage: {
    membershipId: string;
    boardId: string;
    boardName: string;
    stageId: string;
    stageName: string;
    stageColor: string;
  } | null;
  tags: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  notes: Array<{
    id: string;
    body: string;
    createdAt: string;
    createdByName: string | null;
  }>;
  departments: Array<{
    id: string;
    name: string;
  }>;
  boardStages: Array<{
    id: string;
    boardId: string;
    boardName: string;
    name: string;
    color: string;
    order: number;
  }>;
}

export type ConversationActionBody =
  | { action: "add_note"; body: string }
  | { action: "assign_current_user" }
  | { action: "change_department"; departmentId: string | null }
  | { action: "change_priority"; priority: ConversationDto["priority"] }
  | { action: "change_primary_board_stage"; stageId: string }
  | { action: "request_ai_suggestion" }
  | { action: "create_crm_note" };

export interface ConversationActionResultDto {
  conversation: ConversationDto;
  context: ContactContextDto;
  aiSuggestion?: string;
  crmAction?: {
    id: string;
    status: string;
  };
}

async function getRequiredToken(getToken: () => Promise<string | null>) {
  const token = await getToken();

  if (!token) {
    throw new Error("Missing Clerk auth token.");
  }

  return token;
}

function parseBoardWithStages(data: unknown): ContactBoardWithStagesDto {
  const board = contactBoardSchema.parse(data);

  return {
    ...board,
    stages: contactBoardStageSchema.array().parse(
      typeof data === "object" && data !== null && "stages" in data ? data.stages : []
    )
  };
}

function parseBoardContactCard(data: unknown): BoardContactCardDto {
  const membership = contactBoardMembershipSchema.parse(data);

  return {
    ...membership,
    contact: contactSchema.parse(
      typeof data === "object" && data !== null && "contact" in data ? data.contact : null
    )
  };
}

function parseBoardContacts(data: unknown): BoardContactsDto {
  const payload = data as {
    board?: unknown;
    stages?: unknown;
    memberships?: unknown;
  };

  return {
    board: contactBoardSchema.parse(payload.board),
    stages: contactBoardStageSchema.array().parse(payload.stages),
    memberships: Array.isArray(payload.memberships)
      ? payload.memberships.map(parseBoardContactCard)
      : []
  };
}

function parseContactContext(data: unknown): ContactContextDto {
  const payload = data as ContactContextDto;

  return {
    primaryBoardStage: payload.primaryBoardStage ?? null,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    notes: Array.isArray(payload.notes) ? payload.notes : [],
    departments: Array.isArray(payload.departments) ? payload.departments : [],
    boardStages: Array.isArray(payload.boardStages) ? payload.boardStages : []
  };
}

function parseConversationActionResult(data: unknown): ConversationActionResultDto {
  const payload = data as {
    conversation?: unknown;
    context?: unknown;
    aiSuggestion?: unknown;
    crmAction?: unknown;
  };
  const crmAction = payload.crmAction as ConversationActionResultDto["crmAction"] | undefined;

  return {
    conversation: conversationSchema.parse(payload.conversation),
    context: parseContactContext(payload.context),
    ...(typeof payload.aiSuggestion === "string" ? { aiSuggestion: payload.aiSuggestion } : {}),
    ...(crmAction ? { crmAction } : {})
  };
}

export async function apiGetConversations(
  getToken: () => Promise<string | null>
): Promise<ConversationDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/conversations`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load conversations: ${response.status}`);
  }

  const data = await response.json();
  return conversationSchema.array().parse(data);
}

export async function apiGetContacts(
  getToken: () => Promise<string | null>,
  search?: string
): Promise<ContactDto[]> {
  const token = await getRequiredToken(getToken);

  const url = new URL(`${apiUrl}/contacts`);
  if (search?.trim()) {
    url.searchParams.set("search", search.trim());
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load contacts: ${response.status}`);
  }

  const data = await response.json();
  return contactSchema.array().parse(data);
}

export async function apiCreateContact(
  getToken: () => Promise<string | null>,
  body: {
    name?: string;
    phone: string;
    email?: string;
    company?: string;
  }
): Promise<ContactDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/contacts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to create contact: ${response.status}`);
  }

  const data = await response.json();
  return contactSchema.parse(data);
}

export async function apiUpdateContact(
  getToken: () => Promise<string | null>,
  contactId: string,
  body: {
    name?: string;
    phone?: string;
    email?: string;
    company?: string;
  }
): Promise<ContactDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/contacts/${contactId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to update contact: ${response.status}`);
  }

  const data = await response.json();
  return contactSchema.parse(data);
}

export async function apiGetBoards(
  getToken: () => Promise<string | null>
): Promise<ContactBoardWithStagesDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/boards`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load boards: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data.map(parseBoardWithStages) : [];
}

export async function apiGetBoardContacts(
  getToken: () => Promise<string | null>,
  boardId: string
): Promise<BoardContactsDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/boards/${boardId}/contacts`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load board contacts: ${response.status}`);
  }

  const data = await response.json();
  return parseBoardContacts(data);
}

export async function apiAddContactToBoard(
  getToken: () => Promise<string | null>,
  boardId: string,
  body: {
    contactId: string;
    stageId: string;
    isPrimary?: boolean;
  }
): Promise<BoardContactCardDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/boards/${boardId}/memberships`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to add contact to board: ${response.status}`);
  }

  const data = await response.json();
  return parseBoardContactCard(data);
}

export async function apiMoveBoardMembership(
  getToken: () => Promise<string | null>,
  membershipId: string,
  body: {
    stageId: string;
    isPrimary?: boolean;
  }
): Promise<BoardContactCardDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/board-memberships/${membershipId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to move board contact: ${response.status}`);
  }

  const data = await response.json();
  return parseBoardContactCard(data);
}

export async function apiGetChannels(
  getToken: () => Promise<string | null>
): Promise<ChannelDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load channels: ${response.status}`);
  }

  const data = await response.json();
  return channelSchema.array().parse(data);
}

export async function apiCreateChannel(
  getToken: () => Promise<string | null>,
  body: {
    displayName: string;
    providerKey?: string;
    phoneNumber?: string;
  }
): Promise<ChannelDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to create channel: ${response.status}`);
  }

  const data = await response.json();
  return channelSchema.parse(data);
}

export async function apiStartChannelQr(
  getToken: () => Promise<string | null>,
  channelId: string
): Promise<ChannelQrResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels/${channelId}/qr`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to start channel QR: ${response.status}`);
  }

  const data = await response.json();
  return channelQrResultSchema.parse(data);
}

export async function apiReconnectChannel(
  getToken: () => Promise<string | null>,
  channelId: string
): Promise<ChannelOperationResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels/${channelId}/reconnect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to reconnect channel: ${response.status}`);
  }

  const data = await response.json();
  return channelOperationResultSchema.parse(data);
}

export async function apiDisconnectChannel(
  getToken: () => Promise<string | null>,
  channelId: string
): Promise<ChannelOperationResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels/${channelId}/disconnect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to disconnect channel: ${response.status}`);
  }

  const data = await response.json();
  return channelOperationResultSchema.parse(data);
}

export async function apiCreateTestInbound(
  getToken: () => Promise<string | null>,
  channelId: string
): Promise<ChannelTestInboundResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels/${channelId}/test-inbound`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    throw new Error(`Failed to create test inbound message: ${response.status}`);
  }

  const data = await response.json();
  return channelTestInboundResultSchema.parse(data);
}

export async function apiGetConversationMessages(
  conversationId: string,
  getToken: () => Promise<string | null>
): Promise<MessageDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/conversations/${conversationId}/messages`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load messages: ${response.status}`);
  }

  const data = await response.json();
  return messageSchema.array().parse(data);
}

export async function apiCreateConversationMessage(
  conversationId: string,
  body: string,
  getToken: () => Promise<string | null>
): Promise<MessageDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ body })
  });

  if (!response.ok) {
    throw new Error(`Failed to send message: ${response.status}`);
  }

  const data = await response.json();
  return messageSchema.parse(data);
}

export async function apiGetConversationContext(
  conversationId: string,
  getToken: () => Promise<string | null>
): Promise<ContactContextDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/conversations/${conversationId}/context`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load contact context: ${response.status}`);
  }

  const data = await response.json();
  return parseContactContext(data);
}

export async function apiRunConversationAction(
  conversationId: string,
  body: ConversationActionBody,
  getToken: () => Promise<string | null>
): Promise<ConversationActionResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/conversations/${conversationId}/actions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to run conversation action: ${response.status}`);
  }

  const data = await response.json();
  return parseConversationActionResult(data);
}

export function buildRealtimeUrl(token: string) {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/realtime";
  url.searchParams.set("token", token);
  return url.toString();
}
