# Meta Evolution Multi-Channel Design

## Goal

Allow one workspace to operate multiple official Meta WhatsApp numbers connected through Evolution API, with each number represented as its own `meta_cloud` channel.

## Channel Model

Settings keeps the global Evolution credentials needed for server-side calls. Channels hold each official number:

- `provider`: `meta_cloud`
- `providerKey`: Evolution instance name
- `displayName`: user-facing channel name
- `phoneNumber`: optional visible phone number

No schema change is required because channels already have unique provider keys per workspace.

## Campaigns

The Meta template send route accepts an optional `channelId`. When present, the API sends through that connected `meta_cloud` channel's provider key. The campaign editor lists connected Meta channels and uses the selected channel for template listing and sending.

When a template send succeeds, the service creates or updates the contact, opens the conversation for that channel/contact, and stores an outbound template message. This makes the campaign visible in Atendimento before the customer replies.

## Webhooks

Evolution inbound webhooks first try to match `provider = evolution`, then `provider = meta_cloud`. This lets the same Evolution webhook endpoint ingest official Meta instances stored as Meta channels.

When an inbound message lands on a `meta_cloud` channel, the API sets the customer service window to 24 hours after the inbound timestamp. The Atendimento UI can then allow free-text replies during that window.

## Inbox Replies

For `meta_cloud` conversations in via-Evolution mode, the conversation service sends text replies through Evolution using the channel provider key as the instance name. Direct Meta mode keeps using Graph API.
