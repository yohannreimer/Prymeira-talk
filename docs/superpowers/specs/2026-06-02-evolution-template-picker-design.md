# Evolution Template Picker Design

## Goal

Allow users who configured Meta official WhatsApp through Evolution API to browse approved templates from the configured Evolution instance before sending a campaign.

## User Flow

In the Disparos editor, the Meta Cloud section keeps the manual template name and language fields. When the workspace uses `connectionMode: "evolution_official"`, the section also shows a `Carregar templates` action. The action fetches templates from the configured Evolution instance, displays each template name, language/status, and a compact message preview when available. Clicking `Usar` fills the existing template name and language fields.

## Backend

The browser never receives the Evolution API key. A new authenticated settings route resolves the active Meta runtime and calls the configured Evolution client. The endpoint returns normalized template records with stable fields:

- `name`
- `language`
- `status`
- `category`
- `preview`
- `components`

If Meta official via Evolution is inactive, the route returns `409 META_CLOUD_NOT_CONFIGURED`. Provider errors are surfaced as a bad gateway style response with a user-readable message.

## Evolution Parsing

Evolution installations can return template lists in different shapes. The client should normalize common containers such as top-level arrays, `templates`, `data`, or nested template arrays, and preserve raw component structures for future sending with variables.

## Frontend

The Campaigns page loads settings once. It should also retain the active Meta connection mode so the template browser appears only for `evolution_official`. Template loading is explicit, not automatic, to avoid unnecessary provider calls while the user edits a campaign.

## Testing

Add backend tests for Evolution template normalization and route behavior. Add frontend type coverage through the existing web typecheck. Run targeted tests first, then full typecheck/build.
