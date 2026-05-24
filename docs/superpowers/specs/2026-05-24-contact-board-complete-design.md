# Contact Board Complete Design

## Goal

Make the contacts board fully usable from the Prymeira Talk UI, without manual API calls for creating boards, creating stages, adding contacts, moving contacts, or basic board administration.

## Scope

- Create, rename, and delete contact boards from `Contatos > Board`.
- Create, edit, delete, and reorder stages from the same board view.
- Add existing contacts to stages from the UI.
- Move contacts between stages with drag and drop and button controls.
- Remove contacts from a board.
- Keep destructive actions guarded with confirmations and API validation.

## Product Behavior

The board view becomes an operational workspace. When there are no boards, the page offers a board creation form. Once a board exists, users can select it, edit its metadata, create stages, add contacts, and organize cards. Empty stages can be deleted; stages with contacts are protected so users move or remove contacts first.

## API Design

Existing board APIs stay intact. New routes extend the same module:

- `PATCH /boards/:boardId`
- `DELETE /boards/:boardId`
- `PATCH /boards/:boardId/stages/:stageId`
- `DELETE /boards/:boardId/stages/:stageId`
- `PATCH /boards/:boardId/stages/reorder`
- `DELETE /board-memberships/:membershipId`

All operations are workspace-scoped. Stage reorder validates that the submitted stage IDs exactly match the selected board stages before updating sort order.

## UI Design

The board view keeps a dense CRM-style layout:

- Top management area for board selection, creation, and board-level actions.
- Stage creation form beside contact-add controls.
- Each stage column has compact edit, reorder, and delete controls.
- Each contact card keeps movement controls and adds a remove action.

The visual style remains consistent with the current restrained green CRM palette and compact controls.

## Testing

- Backend service tests cover board update/delete, stage update/delete, reorder validation, and membership removal.
- Route tests cover the new HTTP methods and realtime publication for membership deletion.
- Web API tests cover endpoint methods and payloads.
- Existing builds and test suites must continue to pass.
