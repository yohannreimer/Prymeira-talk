# Contact Board Intelligence Design

## Context

The contacts board is already functional: users can create boards, create and reorder stages, manually add contacts to stages, drag contacts between stages, and manage contacts from the contacts module. The current experience is still too manual for a multi-channel operation. A sales channel, support channel, and customer success channel should be able to feed different boards without requiring the operator to manually sort every qualified contact.

The current UI also truncates stage names because stage headers use compact inputs, narrow columns, and single-line text. This makes business stages such as "Interesse forte no plano Empresa" hard to read and weakens the CRM feel of the page.

## Goals

- Make a board eligible only for selected channels.
- Let each stage declare multiple tag triggers.
- Automatically add or advance contacts when a conversation receives a matching tag.
- Keep the automation predictable by preventing one tag from pointing to multiple stages in the same board.
- Let teams manually synchronize existing conversations into the board rules.
- Improve the board UI so stage names and rules are readable and feel premium.

## Non-Goals

- Do not move this first version into the full automations canvas.
- Do not build a generic workflow engine for boards.
- Do not add complex per-rule condition builders.
- Do not make automatic rules regress a manually advanced contact.

## Product Rules

Each board has:

- A set of allowed channels.
- A setting named `isPrimaryPipeline` that determines whether automatic movement in that board should mark the membership as the contact's primary board membership.
- A manual `Sync now` action that applies the board rules to existing conversations.

Each stage has:

- A name and color.
- Zero or more tag triggers.
- A stable order within the board.

Tag trigger rules:

- A stage may have many tag triggers.
- Within a single board, a tag may belong to only one stage.
- The same tag may be used in a different board.
- A stage without tag triggers remains manual.

Automatic movement rules:

- Any source that applies a tag to a conversation can trigger board movement, including AI, human users, API/import flows, or future automations.
- The conversation's channel selects eligible boards.
- The applied tag selects eligible stages within those boards.
- If multiple tags on the same conversation point to different stages in one board, the rightmost stage wins.
- If the contact is not yet in the board, create a membership in the winning stage.
- If the contact is already in the board, move it only when the winning stage is to the right of the current stage.
- Automatic movement must not move a contact backward.
- Manual movement remains allowed. Future automation can still advance the contact, but cannot regress it.

Manual sync rules:

- The board exposes `Sync now`.
- The user chooses a scope: `active`, `closed`, or `all`.
- The sync applies the same channel and tag rules to conversations in the chosen scope.
- The result reports how many contacts were evaluated, added, moved, ignored, and conflicted.

## UX Design

The board page keeps the existing list/board switch and board creation flow, but the board mode becomes clearer and more operational.

The board command area becomes a compact control bar:

- Active board selector.
- Channel chips for the selected board.
- Primary pipeline indicator when enabled.
- Actions: `Gerenciar`, `Nova etapa`, `Adicionar contato`, `Sincronizar`.

The `Gerenciar` panel adds a `Regras do board` section:

- Multi-select or checkbox list of channels.
- Toggle for `Usar como funil principal`.
- Short helper copy explaining that only conversations from selected channels can trigger this board.

Each stage uses a richer header:

- Full stage name, allowed to wrap.
- Color swatch.
- Contact count.
- Trigger tags shown as chips.
- A clear `Editar etapa` affordance.

The stage edit panel supports:

- Stage name.
- Stage color.
- Multiple trigger tags.
- Save, delete, and reorder actions.

Readability requirements:

- Stage names must not be truncated.
- Contact names on board cards may wrap to two lines.
- Metadata such as phone, company, or source may remain compact.
- Stage columns may be wider than today and use horizontal scrolling.

## Data Model

Add board-to-channel and stage-to-tag relationships.

Suggested schema additions:

```prisma
enum ContactBoardMoveSource {
  manual
  rule
}

model ContactBoardChannel {
  workspaceId String @map("workspace_id")
  boardId     String @map("board_id") @db.Uuid
  channelId   String @map("channel_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")

  board   ContactBoard @relation(fields: [workspaceId, boardId], references: [workspaceId, id], onDelete: Cascade)
  channel Channel      @relation(fields: [workspaceId, channelId], references: [workspaceId, id], onDelete: Cascade)

  @@id([workspaceId, boardId, channelId])
  @@index([workspaceId, channelId])
  @@map("contact_board_channels")
}

model ContactBoardStageTag {
  workspaceId String @map("workspace_id")
  boardId     String @map("board_id") @db.Uuid
  stageId     String @map("stage_id") @db.Uuid
  tagId       String @map("tag_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")

  stage ContactBoardStage @relation(fields: [workspaceId, boardId, stageId], references: [workspaceId, boardId, id], onDelete: Cascade)
  tag   Tag               @relation(fields: [workspaceId, tagId], references: [workspaceId, id], onDelete: Cascade)

  @@id([workspaceId, boardId, tagId])
  @@index([workspaceId, boardId, stageId])
  @@map("contact_board_stage_tags")
}
```

Extend existing models:

- `ContactBoard.isPrimaryPipeline Boolean @default(false)`
- `ContactBoard.channels ContactBoardChannel[]`
- `ContactBoardStage.tagTriggers ContactBoardStageTag[]`
- `Tag.boardStageTriggers ContactBoardStageTag[]`
- `Channel.contactBoards ContactBoardChannel[]`

For movement tracking, add lightweight fields to `ContactBoardMembership`:

- `lastMovedBy ContactBoardMoveSource @default(manual)`
- `lastRuleAppliedAt DateTime?`

Where `ContactBoardMoveSource` is `manual` or `rule`.

## API Design

Update board DTOs:

- `ContactBoardDto` includes `isPrimaryPipeline` and `channels`.
- `ContactBoardStageDto` includes `tagTriggers`.
- `BoardContactsDto` returns the enriched board and stages.

Update board endpoints:

- `GET /boards`: include channels and stage tag triggers.
- `GET /boards/:boardId/contacts`: include channels and stage tag triggers.
- `POST /boards`: accepts `channelIds` and `isPrimaryPipeline`.
- `PATCH /boards/:boardId`: accepts `channelIds` and `isPrimaryPipeline`.
- `POST /boards/:boardId/stages`: accepts `tagIds`.
- `PATCH /boards/:boardId/stages/:stageId`: accepts `tagIds`.
- `POST /boards/:boardId/sync-rules`: accepts `{ scope: "active" | "closed" | "all" }`.

The sync response includes:

```ts
{
  evaluated: number;
  added: number;
  moved: number;
  ignored: number;
  conflicts: number;
}
```

## Rule Service

Create a board rules service with a small public surface:

- `applyBoardRulesForConversationTags({ workspaceId, conversationId })`
- `syncBoardRules({ workspaceId, boardId, scope })`

The service should:

- Load the conversation, channel, contact, and current tags.
- Find boards that include the conversation channel.
- Resolve the target stage for each board by comparing matching tag triggers and picking the highest ordered stage.
- Upsert or move memberships only when the target stage advances the contact.
- Mark created or moved memberships as primary only when the board has `isPrimaryPipeline` enabled.
- Publish existing realtime events for membership updates.

Trigger points:

- After the conversation action `add_tag` succeeds.
- After any route or service that directly creates a `ConversationTag`.
- During manual board sync.

Future tag-writing paths must call the same rule service rather than duplicating the movement logic.

## Error Handling

- Reject stage save when a selected tag is already linked to another stage in the same board.
- Allow boards with no selected channels, but show a warning that automatic rules will not run.
- Allow stages with no tags, but treat them as manual-only.
- Return a clear validation error if sync is requested for a missing board or invalid scope.
- If a stage tag mapping references an inactive tag, keep it visible but mark it inactive in the UI.

## Testing

Backend tests:

- Board create/update stores selected channels and primary pipeline flag.
- Stage create/update stores multiple tag triggers.
- A tag cannot be linked to two stages in the same board.
- Same tag can be linked in different boards.
- Conversation tag application moves only boards whose channel matches.
- Multiple matching tags choose the rightmost stage.
- Rule movement advances but does not regress.
- Primary membership is set only when `isPrimaryPipeline` is true.
- Sync supports `active`, `closed`, and `all` scopes and returns a useful summary.

Frontend tests:

- Board helper renders selected channels and stage trigger tags.
- Stage names and board contact names no longer depend on single-line truncation.
- Stage tag editor prevents duplicate tag assignment within a board.
- Sync scope selector sends the expected request body.

Verification:

- Run full tests with `npx pnpm@10.0.0 -r test`.
- Run full build with `npx pnpm@10.0.0 -r build`.

## Implementation Notes

`ContactsPage.tsx` is already large and owns list view, board view, drawers, forms, realtime, and drag/drop. The implementation should extract focused board pieces while touching this area:

- Board command bar.
- Board rules panel.
- Stage header/editor.
- Board sync controls.
- Board rule DTO helpers.

This keeps the feature understandable and avoids making the page harder to maintain.
