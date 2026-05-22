# Multi-Channel WhatsApp Operations Design

## Context

Prymeira Talk now connects to Evolution in real mode and can receive WhatsApp messages, but the Canais and Atendimento flows still behave like there is only one WhatsApp channel per workspace. `Conectar canal` currently reuses the selected channel, `Reconectar` only changes status without showing a new QR, channel rows expose long technical instance names, and Atendimento does not let the operator filter conversations by the chip/channel that received the message.

The next iteration should make channels operationally useful for multiple chips. A workspace may have several WhatsApp numbers connected at once, such as Comercial, Suporte, and a client-specific chip. Operators need to connect, reconnect, disconnect, remove, and filter by those channels without seeing provider implementation details.

## Goals

- Allow multiple WhatsApp channels per workspace, each with a human-readable name.
- Make `Novo canal` always create a fresh channel and request a fresh QR.
- Make `Reconectar` request and show a fresh QR for the selected existing channel.
- Separate `Desconectar` from `Apagar`: disconnect should stop the session, delete should remove the channel from the workspace.
- Hide the long Evolution provider key from the normal UI while preserving it for backend lookup.
- Add channel filters to Atendimento so operators can see conversations from all chips or one chip.
- Display the contact phone number when a contact does not yet have a saved name.
- Capture an incoming WhatsApp push name when Evolution provides one and the local contact has no name yet.

## Non-Goals

- Do not build full client/account ownership for channels in this pass.
- Do not add billing, seat permissions, or channel-level ACLs.
- Do not migrate to official WhatsApp Cloud API in this pass.
- Do not implement advanced contact merge logic beyond phone-based upsert.

## User Experience

### Canais

The primary action becomes `Novo canal`. Clicking it opens a drawer with a required visible name field, for example `Comercial`, `Suporte`, or `Cliente Ana`. After submit, the backend creates a channel with that display name and a unique technical provider key, then starts the QR session for that new channel.

Channel rows show:

- Status badge.
- Visible channel name.
- Phone number when known.
- Small provider label, such as `Evolution API`.
- Actions: `Conectar QR` or `Reconectar`, `Desconectar`, and `Apagar`.

The technical provider key should remain available in developer-oriented details only if needed, not as the main identifier.

### Reconnect

`Reconectar` must behave like “generate a fresh QR for this existing channel.” It should open the QR drawer and call the same backend QR session path used for initial connection, using the selected channel id. It should not merely set status to `connecting`.

### Disconnect And Delete

`Desconectar` keeps the channel record and marks it disconnected. This is reversible.

`Apagar` removes the channel record after a confirmation. If deletion is risky because conversations reference the channel, the backend should use the existing cascade behavior intentionally or block deletion with a clear error. For this project, deleting a channel may cascade its conversations because the Prisma relation already uses `onDelete: Cascade`.

### Atendimento

Atendimento gains a compact channel filter near the conversation list summary:

- `Todos`
- One option per channel display name

Conversation cards show the channel origin in a compact line, for example `via Comercial`. The existing DTO already includes `channelId` and `channelName`, so the first version can filter client-side over the loaded conversations.

If a conversation has no `contactName`, the UI should show `contactPhone`. It should only fall back to `Contato <id>` when neither name nor phone is available.

## Backend Design

### Channel Creation

The channel creation endpoint continues to accept `displayName`. If `providerKey` is omitted, the backend generates a unique technical key. The generated key should include stable workspace context plus a short random suffix to avoid collisions across channels and workspaces. It should not rely on the visible name alone.

### QR Session

`startQrSession` remains the single backend operation that starts or restarts QR pairing for a channel.

When Evolution reports “instance already in use,” the service may call `connectInstance` as it does today. That behavior is correct for reconnecting an existing provider key.

### Reconnect Endpoint

The current `POST /channels/:channelId/reconnect` operation updates status only. The UI should stop using it for QR reconnection. It can remain available as a low-level status operation, but user-facing `Reconectar` should call `POST /channels/:channelId/qr`.

### Delete Endpoint

Add `DELETE /channels/:channelId`. It should:

- Validate the channel belongs to the current workspace.
- Delete the channel.
- Publish `channel.deleted` or publish enough realtime state for the UI to remove it.
- Return `{ ok: true, channelId }`.

Shared realtime schemas should include the new event if needed.

### Incoming Contact Names

Evolution webhook ingestion should extract a contact display name when available in the payload. Candidate fields include `pushName`, `data.pushName`, `data.key.pushName`, or equivalent Evolution v2 fields. If the existing contact name is null, update it to the extracted push name. If a local name already exists, preserve the local name.

## Frontend Design

### Canais Page

State additions:

- `createChannelDrawerOpen`
- `newChannelName`
- QR drawer should track the target channel result.

Behavior changes:

- `Novo canal` opens the create drawer.
- Submit create drawer calls `apiCreateChannel`, then `apiStartChannelQr` for the created channel.
- `Reconectar` opens the QR drawer and calls `apiStartChannelQr` for that row.
- `Apagar` prompts for confirmation and calls the delete endpoint.
- Row selection should not implicitly clear QR state for unrelated channels unless the QR drawer is closed.

### Atendimento Page

State additions:

- `selectedChannelFilter`, default `all`.

Derived values:

- `availableChannels` from conversations by `channelId` and `channelName`.
- `visibleConversations` filtered by selected channel.

Display changes:

- Use `contactName ?? contactPhone ?? fallback`.
- Show `via <channelName>` on conversation cards.
- Filter tabs/chips sit above the conversation list.

## Data Flow

1. User creates a channel with visible name.
2. API stores `displayName` and generated `providerKey`.
3. API starts Evolution QR for that channel.
4. UI renders QR and waits for connection updates.
5. Evolution webhooks update channel status and create conversations/messages.
6. Conversations include `channelId`, `channelName`, `contactName`, and `contactPhone`.
7. Atendimento filters conversations locally by channel.

## Error Handling

- If channel creation fails with conflict, show a human-readable duplicate/channel conflict message.
- If QR generation fails because Evolution is unlicensed, reuse the existing `EVOLUTION_LICENSE_REQUIRED` message.
- If QR generation succeeds but no QR is returned, keep the channel disconnected and show a clear QR unavailable message.
- If delete fails due to backend constraint or missing channel, show a clear error and keep the row.

## Testing

Backend tests:

- Creating two channels without provider keys yields two different provider keys.
- `POST /channels/:channelId/qr` still starts QR for an existing channel.
- `DELETE /channels/:channelId` deletes only workspace-owned channels and returns `channelId`.
- Evolution webhook creates or updates contacts with phone and push name when available, without overwriting an existing saved name.

Frontend tests:

- `Novo canal` creates a channel and then requests QR for the new channel id.
- `Reconectar` requests QR and opens the QR drawer.
- Channel filter hides conversations from other channels.
- Contact display name falls back to phone before id.

## Open Decision

Client/email ownership for a channel is useful but deferred. The current pass should add a flexible channel name and filter model so client ownership can be layered on later without reworking the QR flow.
