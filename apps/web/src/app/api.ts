import {
  contactSchema,
  conversationSchema,
  messageSchema,
  type ContactDto,
  type ConversationDto,
  type MessageDto
} from "@prymeira-talk/shared";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3002";

export async function apiGetConversations(
  getToken: () => Promise<string | null>
): Promise<ConversationDto[]> {
  const token = await getToken();

  if (!token) {
    throw new Error("Missing Clerk auth token.");
  }

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
  const token = await getToken();

  if (!token) {
    throw new Error("Missing Clerk auth token.");
  }

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
  const token = await getToken();

  if (!token) {
    throw new Error("Missing Clerk auth token.");
  }

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
  const token = await getToken();

  if (!token) {
    throw new Error("Missing Clerk auth token.");
  }

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

export async function apiGetConversationMessages(
  conversationId: string,
  getToken: () => Promise<string | null>
): Promise<MessageDto[]> {
  const token = await getToken();

  if (!token) {
    throw new Error("Missing Clerk auth token.");
  }

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
