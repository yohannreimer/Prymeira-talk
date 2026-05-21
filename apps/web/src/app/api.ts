import {
  contactBoardMembershipSchema,
  contactBoardSchema,
  contactBoardStageSchema,
  contactSchema,
  conversationSchema,
  messageSchema,
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

export function buildRealtimeUrl(token: string) {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/realtime";
  url.searchParams.set("token", token);
  return url.toString();
}
