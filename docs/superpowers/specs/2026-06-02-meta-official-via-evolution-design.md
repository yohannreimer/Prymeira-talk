# Meta Official Via Evolution Design

## Goal

Allow Prymeira Talk to use a real official Meta WhatsApp number that is already connected inside Evolution API, without forcing the customer to reconnect the number directly through Meta inside Prymeira Talk.

## Scope

This is a transport option for the existing `meta_cloud` feature. The product remains visually framed as "WhatsApp API Oficial Meta", but Settings lets the owner or manager choose how the official number is connected:

- `direct`: Prymeira Talk talks directly to Meta Cloud API.
- `evolution_official`: Prymeira Talk talks to Evolution API, and Evolution talks to Meta Cloud API.

This phase does not implement "Connect with Meta" OAuth inside Prymeira Talk and does not create official Evolution Cloud API instances from Prymeira Talk. It uses an instance that already exists in Evolution.

## Settings

When Meta is inactive, the UI remains compact. When Meta is active, Settings shows a connection mode segmented control.

For direct Meta, Settings keeps the current required fields:

- WABA ID
- Phone Number ID
- Access token
- Webhook verify token
- App Secret

For official Meta via Evolution, Settings requires:

- Evolution Base URL
- Evolution API key
- Evolution instance name

Secret fields are masked when read back from the API. Saving an unchanged masked or blank secret preserves the stored value.

## Channels

Channels continue to use provider `meta_cloud` for official Meta channels. In `evolution_official` mode, the Meta channel `providerKey` is the Evolution instance name. The UI labels the provider as "Meta oficial via Evolution" where useful, and does not show QR/reconnect/disconnect actions for this official channel.

The Meta provider option appears only after Settings has a complete active config for either direct Meta or via Evolution.

## Campaigns

Direct Meta template campaigns keep the current Meta Graph API path.

In `evolution_official` mode, the existing `/campaigns/:campaignId/send-meta-template` route sends each recipient through Evolution's template send API using the configured official instance name. Template name, language, and supported text parameters are still supplied by the Prymeira Talk campaign UI.

Because template cache sync from Meta direct API requires WABA credentials, this phase disables the "Sincronizar templates" button in Settings for `evolution_official` mode. The operator manually enters template name/language in Campaigns, matching the current UI.

## Webhooks And Inbox

Inbound messages for the Evolution official instance continue through the existing Evolution webhook endpoint. The channel record is `meta_cloud`, so the inbox can display it as an official Meta channel. Free-text service-window enforcement remains tied to direct Meta webhooks for now; Evolution-official inbound messages use the existing Evolution ingestion path in this phase.

## Error Handling

If official Meta via Evolution is enabled but the Evolution Base URL, API key, or instance name is missing, Settings rejects activation. If template sending through Evolution fails, Campaigns surfaces the same failed-recipient behavior already used by Meta direct campaigns.

## Verification

- Settings can activate/deactivate direct Meta and via-Evolution modes.
- Secret masking preserves Evolution API key.
- Channels exposes "Meta oficial" only after complete activation.
- A Meta channel can be created with the Evolution instance name.
- Campaign template send calls Evolution's template endpoint in via-Evolution mode.
- Existing direct Meta and Evolution flows continue to pass tests.
