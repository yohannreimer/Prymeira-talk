# WhatsApp groups in Talk

## Problem

Evolution sends group messages with a `@g.us` remote JID. The Talk webhook currently resolves only individual phone identities and silently ignores group messages. Channel history import also intentionally omits groups. A group therefore never reaches the inbox.

## Approved behavior

- An Evolution channel accepts messages from groups in which the connected number participates.
- The inbox shows each group as a separate conversation with its group name, channel, unread count and recent activity.
- Each inbound message displays the participant's name or identifier. Human agents can send text and supported attachments to the group.
- A group identity stays out of Contacts, CRM boards, campaigns, broadcast lists and direct chat pickers.
- Messages in groups do not trigger automation flows, autonomous AI replies, private assistant suggestions, follow-ups, triage or automatic department routing. Human assignment and inbox status continue to work.
- Existing direct conversations and channel behavior remain compatible.

## Storage and boundaries

Use a typed group identity in the existing conversation/contact relation to avoid changing the many existing direct-chat foreign keys. Add `Contact.isGroup` (default false) and `ConversationDto.isGroup`. Group identities use the exact Evolution group JID as their stored address, never normalized as a phone. Filter `isGroup` identities at every contact-recipient entry point. The conversation owns the group identity by channel and contact ID; no direct contact shares that ID.

The webhook recognizes only valid `@g.us` group JIDs. It obtains a group subject from Evolution group info, with a visible fallback if unavailable. It stores sender label and JID in message metadata and exposes only those safe fields in the message DTO. Group messages are persisted with the same idempotency key as direct messages. Group handling branches before contact lookup, assistant scheduling and other direct-chat observers.

Outgoing manual messages use the stored group JID as Evolution's `number`. The conversation service rejects contact-card sends to group chats. The inbox hides contact editing, CRM context and AI controls for group chats while retaining the normal composer.

## Verification

Exercise group webhook ingestion, deduplication, sender display, group name fallback, manual send, and filters that prevent group identities from being used as direct-message recipients. Run API and web tests, typecheck and build. Validate against the running channel after publication without sending a test message to a real group unless the user asks.
