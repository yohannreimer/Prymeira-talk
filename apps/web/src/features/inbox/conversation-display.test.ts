import type { ConversationDto } from "@prymeira-talk/shared";
import { describe, expect, it } from "vitest";
import {
  contactDisplayName,
  filterConversationsByChannel,
  filterConversationsByQueue,
  getChannelFilterOptions
} from "./conversation-display";

function conversationFixture(overrides: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id: "conversation-1",
    workspaceId: "workspace-1",
    channelId: "channel-alpha-1234",
    contactId: "contact-alpha-1234",
    contactName: null,
    contactPhone: null,
    channelName: null,
    departmentName: null,
    assignedUserName: null,
    status: "open",
    assignedUserId: null,
    departmentId: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    unreadCount: 0,
    priority: "normal",
    ...overrides
  };
}

describe("conversation display helpers", () => {
  describe("contactDisplayName", () => {
    it("uses the saved contact name first", () => {
      expect(contactDisplayName(conversationFixture({ contactName: "Ana Silva", contactPhone: "+5511999999999" }))).toBe(
        "Ana Silva"
      );
    });

    it("falls back to contact phone", () => {
      expect(contactDisplayName(conversationFixture({ contactPhone: "+5511988888888" }))).toBe("+5511988888888");
    });

    it("falls back to a shortened contact id label", () => {
      expect(contactDisplayName(conversationFixture({ contactId: "contact-zeta-9999" }))).toBe("Contato contact-");
    });
  });

  describe("getChannelFilterOptions", () => {
    it("returns all plus unique channels in first-seen order", () => {
      const conversations = [
        conversationFixture({ id: "conversation-1", channelId: "channel-alpha-1234", channelName: "WhatsApp Loja" }),
        conversationFixture({ id: "conversation-2", channelId: "channel-beta-5678", channelName: "WhatsApp Suporte" }),
        conversationFixture({ id: "conversation-3", channelId: "channel-alpha-1234", channelName: "Outro nome" })
      ];

      expect(getChannelFilterOptions(conversations)).toEqual([
        { id: "all", label: "Todos" },
        { id: "channel-alpha-1234", label: "WhatsApp Loja" },
        { id: "channel-beta-5678", label: "WhatsApp Suporte" }
      ]);
    });

    it("falls back to a shortened channel id label", () => {
      expect(
        getChannelFilterOptions([conversationFixture({ channelId: "channel-gamma-9999", channelName: null })])
      ).toEqual([
        { id: "all", label: "Todos" },
        { id: "channel-gamma-9999", label: "Canal channel-" }
      ]);
    });
  });

  describe("filterConversationsByChannel", () => {
    it("returns every conversation for the all filter", () => {
      const conversations = [
        conversationFixture({ id: "conversation-1", channelId: "channel-alpha-1234" }),
        conversationFixture({ id: "conversation-2", channelId: "channel-beta-5678" })
      ];

      expect(filterConversationsByChannel(conversations, "all")).toBe(conversations);
    });

    it("returns only conversations matching the selected channel", () => {
      const alpha = conversationFixture({ id: "conversation-1", channelId: "channel-alpha-1234" });
      const beta = conversationFixture({ id: "conversation-2", channelId: "channel-beta-5678" });

      expect(filterConversationsByChannel([alpha, beta], "channel-beta-5678")).toEqual([beta]);
    });
  });

  describe("filterConversationsByQueue", () => {
    it("returns open and pending conversations for the active queue", () => {
      const open = conversationFixture({ id: "conversation-open", status: "open" });
      const pending = conversationFixture({ id: "conversation-pending", status: "pending" });
      const closed = conversationFixture({ id: "conversation-closed", status: "closed" });

      expect(filterConversationsByQueue([open, pending, closed], "active")).toEqual([open, pending]);
    });

    it("returns open and pending conversations for the mine queue", () => {
      const open = conversationFixture({ id: "conversation-open", status: "open" });
      const pending = conversationFixture({ id: "conversation-pending", status: "pending" });
      const closed = conversationFixture({ id: "conversation-closed", status: "closed" });

      expect(filterConversationsByQueue([open, pending, closed], "mine")).toEqual([open, pending]);
    });

    it("returns closed conversations for the closed queue", () => {
      const open = conversationFixture({ id: "conversation-open", status: "open" });
      const closed = conversationFixture({ id: "conversation-closed", status: "closed" });

      expect(filterConversationsByQueue([open, closed], "closed")).toEqual([closed]);
    });

    it("returns every conversation for the all queue", () => {
      const open = conversationFixture({ id: "conversation-open", status: "open" });
      const closed = conversationFixture({ id: "conversation-closed", status: "closed" });

      expect(filterConversationsByQueue([open, closed], "all")).toEqual([open, closed]);
    });
  });
});
