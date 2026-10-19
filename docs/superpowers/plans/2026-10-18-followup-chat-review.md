# Follow-up Chat Review Implementation Plan

> Execute inline with executing-plans; user explicitly requested no subagents.

**Goal:** Publish the approved conversation-first review interface without sending test messages.

**Architecture:** Add a review-only React component beneath FollowupsPage's existing filter/header. Keep all mutations in the existing parent and pass callbacks, pending/error state and per-conversation realtime revisions. Fetch history through apiGetConversationMessages with AbortController and an explicit context identity; retain versioned drafts per item. Reuse InboxMedia and MessageTicks. Other filters retain FollowupCard.

**Tech Stack:** React 19, TypeScript, Vite, Vitest/jsdom, existing authenticated API and Swarm/Portainer deployment.

## Tasks

- [x] Add `FollowupReview.tsx` and `followup-review.css`: active ID stable through list refresh, next item at removed item's index, optional searchable sidebar with Escape/close, readonly history capped at 100 with batches of 20, dates and media, draft field and explicit send, secondary actions and separate confirmations. Guard navigation and actions while pending; guard send until the current history request succeeds. Version drafts by followup ID/updatedAt/realtime revision.
- [x] Integrate in `FollowupsPage.tsx` only for review. Increment conversation revision on message.created/message.updated/conversation.updated for visible conversations. Reuse runAction/sendBody; keep expectedUpdatedAt and stale handling. Compact the review header/content without changing other tabs.
- [x] Adapt `FollowupsPage.test.tsx` for conversation review while retaining filter/reminder/stale/action guards. Add isolated `FollowupReview.test.tsx` cases for history races and failure, pagination/media, draft persistence/invalidation, sidebar selection/search, confirmation, and successful removal advancing. Mock APIs; never exercise real send endpoints.
- [x] Run `pnpm --filter @prymeira-talk/web test`, `pnpm --filter @prymeira-talk/web typecheck`, and `pnpm --filter @prymeira-talk/web build`. Review diff and inspect synthetic browser fixture at desktop and narrow width; fix any failures before committing. No schema/API changes expected.
- [ ] Push branch, open PR with scope/validation, await green exact-head CI, merge exact head, await validated merge release manifest, compare migrations, record active image rollback digests, update API/web using manifest digests. Verify container revision/health/logs and public HTTP health/ready/web. Save sanitized deployment evidence and enqueue factual brain report; do not send WhatsApp messages.

Local verification: 656 web tests passed across 95 files; web build/typecheck passed. Synthetic browser fixture verified desktop and 390px mobile, searchable queue closes after selection, drafts remain editable. Fixture files moved outside the repository; no real outbound call.
