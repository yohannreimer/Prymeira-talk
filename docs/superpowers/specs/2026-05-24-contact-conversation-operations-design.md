# Contact Conversation Operations Design

## Goal

Stabilize the first operational contact and atendimento workflows before expanding the board module. This cut fixes contact identity, realtime conversation display, unread behavior, outbound conversation start, and simple tags.

## Scope

In scope:
- Normalize Brazilian phone numbers so manual contacts and Evolution webhooks resolve to the same contact when the only difference is the mobile ninth digit.
- Keep realtime `conversation.updated` payloads complete with contact and channel data.
- Clear unread counts when an agent opens a conversation.
- Start a conversation from an existing contact by choosing a WhatsApp channel.
- Add and remove conversation tags from the atendimento side panel.

Out of scope:
- Full board builder UI. Board creation, stage creation, and richer board operations will be a separate cut.
- Contact merge UI. This cut prevents new duplicates and can reconcile contact creation/update conflicts, but it does not provide a manual merge screen.
- WhatsApp templates or paid template approval flows.

## Phone Normalization

Phones are normalized at API boundaries and Evolution webhook ingestion. The canonical stored phone is digits only, with optional leading `+` removed. For Brazilian mobile numbers, if the number has country code `55`, two-digit area code, and a ninth digit immediately after the area code, the canonical comparison key removes that ninth digit. This lets `554799136920` and `5547999136920` match the same contact.

Manual create/update should first look for an existing contact by canonical equivalent. If one exists, the API updates that contact instead of creating a duplicate. Evolution webhook ingestion uses the same lookup before contact upsert.

## Conversation Realtime And Unread

Any service method that publishes or returns an updated conversation must include contact and channel relations before mapping to `ConversationDto`. This avoids temporary UI fallbacks such as `Contato cbeff899` and `Canal sem nome`.

Opening a conversation marks its unread count as zero. The API exposes this as `POST /conversations/:conversationId/read`, and the web calls it when a conversation becomes selected. The resulting `conversation.updated` event keeps other clients in sync.

## Starting Conversations

Contacts get a primary action: `Iniciar conversa`. The user chooses a channel when more than one channel exists. The backend endpoint `POST /contacts/:contactId/conversations` creates or reuses an open conversation for that contact/channel and returns the conversation. The web switches to atendimento with that conversation selected.

This cut starts the thread; sending the first text still uses the existing composer endpoint.

## Tags

The atendimento context card shows current tags as chips. It also has a compact input to add a tag by name. The backend action creates the tag if needed and links it to the conversation. Existing chips can be removed. The context reloads after each change, and `conversation.updated` keeps list data consistent.

## Testing

Add targeted API tests for phone normalization, start conversation, read marking, complete realtime conversation mapping, and tag actions. Add web tests for phone helper behavior where useful and run existing web build/typecheck.
