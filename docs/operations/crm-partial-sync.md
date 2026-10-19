# CRM lead synchronization and partial outcomes

Real lead creation uses one durable `crm_lead_syncs` row per workspace/contact. A bounded lease fences concurrent workers; provider calls have a 15 second timeout and run outside database transactions. The confirmed remote contact and lead IDs are saved before the optional contact note is attempted.

Concurrent creation of that first local row returns `CRM_SYNC_IN_PROGRESS` (409) for the losing request, just like an occupied lease. Only the exact workspace/contact uniqueness conflict is translated; unrelated database errors remain failures. The losing request does not retry or call the provider.

An explicit rejection before note acceptance (400, 401, 403, 404, 422 or 429) leaves `note_pending`. A later authorized create-lead request resumes the note on the saved remote lead. It does not create another lead.

A note timeout, 5xx response, interrupted `note_sending` state or unreadable response leaves `note_uncertain`. The API returns `CRM_NOTE_DELIVERY_UNCERTAIN` (409), explaining that the lead is saved and the note needs review. A recorded `review_required` action distinguishes this partial result from completion. Retrying create-lead cannot repeat that uncertain note POST or create a replacement lead.

An interrupted `creating_lead` state is similarly retained as `lead_uncertain` with `CRM_LEAD_DELIVERY_UNCERTAIN`. Staff must inspect the intended remote CRM record before deciding how to resolve it. The implementation does not infer delivery from names or invent an unsupported remote lookup/idempotency API. Automatic redrive of uncertain notes and an operator resolution API are intentionally unavailable; controlled review is required. Do not clear the durable operation merely to bypass this protection.

Apply `20261015163000_crm_lead_sync` before deploying this service. If the durable model or claim is unavailable, real lead creation fails before provider I/O. Simulated CRM actions do not require the external synchronization model.
