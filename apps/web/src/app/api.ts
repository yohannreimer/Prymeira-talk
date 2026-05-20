import { conversationSchema, type ConversationDto } from "@prymeira-talk/shared";

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

export function buildRealtimeUrl(token: string) {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/realtime";
  url.searchParams.set("token", token);
  return url.toString();
}
