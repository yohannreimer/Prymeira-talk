# Inbox Control Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact, accessible avatar overlay that distinguishes an unseen human handoff, human-controlled conversations, and conversations actively handled by AI without increasing the conversation-card height.

**Architecture:** Keep the status mapping pure in the existing conversation display helper module. `InboxPage` will calculate the existing acknowledgement-aware handoff flag, ask the helper for a badge descriptor, then render the matching Lucide icon inside the existing avatar wrapper. CSS alone anchors the 20 px overlay and supplies semantic red, blue, and purple variants.

**Tech Stack:** React 19, TypeScript, Vitest, Lucide React, existing Prymeira Talk CSS tokens.

---

## File structure

- Modify: `apps/web/src/features/inbox/conversation-display.ts` — define the status-to-badge mapping without React dependencies.
- Modify: `apps/web/src/features/inbox/conversation-display.test.ts` — cover the priority and absence rules for the mapping.
- Modify: `apps/web/src/features/inbox/InboxPage.tsx` — render the overlay and append the status phrase to the card’s accessible name.
- Modify: `apps/web/src/styles.css` — position and color the overlay without changing card layout metrics.

### Task 1: Define and test the control badge mapping

**Files:**

- Modify: `apps/web/src/features/inbox/conversation-display.ts`
- Modify: `apps/web/src/features/inbox/conversation-display.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Append this import and test group to `conversation-display.test.ts`:

```ts
import { getConversationControlBadge } from "./conversation-display";

describe("getConversationControlBadge", () => {
  it("prioritizes an unseen human handoff over the persisted human state", () => {
    expect(getConversationControlBadge(
      conversationFixture({ aiControlStatus: "human_controlled", activeAgentSessionStatus: "handoff_requested" }),
      true
    )).toEqual({ kind: "attention", label: "Ação humana necessária" });
  });

  it("shows a human badge once the handoff is acknowledged", () => {
    expect(getConversationControlBadge(
      conversationFixture({ aiControlStatus: "human_controlled", activeAgentSessionStatus: "handoff_requested" }),
      false
    )).toEqual({ kind: "human", label: "Humano está atendendo" });
  });

  it("shows an AI badge only for an active agent session", () => {
    expect(getConversationControlBadge(
      conversationFixture({ aiControlStatus: "agent_allowed", activeAgentSessionStatus: "active", activeAgentName: "Secretaria IA" }),
      false
    )).toEqual({ kind: "agent", label: "IA está atendendo" });

    expect(getConversationControlBadge(
      conversationFixture({ aiControlStatus: "agent_allowed", activeAgentSessionStatus: "paused_by_human", activeAgentName: "Secretaria IA" }),
      false
    )).toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```sh
pnpm --filter @prymeira-talk/web test -- conversation-display.test.ts
```

Expected: the TypeScript/Vitest run fails because `getConversationControlBadge` is not exported.

- [ ] **Step 3: Add the minimal pure helper**

Append the following definitions to `conversation-display.ts`:

```ts
export type ConversationControlBadge =
  | { kind: "attention"; label: "Ação humana necessária" }
  | { kind: "human"; label: "Humano está atendendo" }
  | { kind: "agent"; label: "IA está atendendo" };

export function getConversationControlBadge(
  conversation: Pick<ConversationDto, "aiControlStatus" | "activeAgentSessionStatus" | "activeAgentName">,
  showHumanAttention: boolean
): ConversationControlBadge | null {
  if (showHumanAttention) return { kind: "attention", label: "Ação humana necessária" };
  if (conversation.aiControlStatus === "human_controlled") return { kind: "human", label: "Humano está atendendo" };
  if (
    conversation.aiControlStatus === "agent_allowed" &&
    conversation.activeAgentSessionStatus === "active" &&
    Boolean(conversation.activeAgentName)
  ) {
    return { kind: "agent", label: "IA está atendendo" };
  }
  return null;
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```sh
pnpm --filter @prymeira-talk/web test -- conversation-display.test.ts
```

Expected: all `conversation display helpers` tests pass, including the new control badge cases.

### Task 2: Render the compact badge in the conversation card

**Files:**

- Modify: `apps/web/src/features/inbox/InboxPage.tsx:1-35,1318-1378`
- Modify: `apps/web/src/styles.css:5846-6025`
- Test: `apps/web/src/features/inbox/conversation-display.test.ts`

- [ ] **Step 1: Extend the failing tests with the approved labels**

Keep the three assertions from Task 1 as the regression contract: `attention` must win while the red alert is unacknowledged, `human` must appear after acknowledgement, and a paused or absent agent must produce `null`. This is the render contract because the component only chooses an icon from `badge.kind` and uses `badge.label` in its accessible name.

Run:

```sh
pnpm --filter @prymeira-talk/web test -- conversation-display.test.ts
```

Expected: PASS before UI rendering changes; the helper contract protects the three card variants.

- [ ] **Step 2: Add the icon imports and helper import**

In `InboxPage.tsx`, add `TriangleAlert` and `UserRound` to the existing Lucide import and add `getConversationControlBadge` to the import from `./conversation-display`.

- [ ] **Step 3: Calculate the badge and append its accessible status**

Immediately after `showHumanAttention` is calculated in the conversation list map, add:

```ts
const controlBadge = getConversationControlBadge(conversation, showHumanAttention);
const conversationAriaLabel = [
  `Abrir conversa com ${contactDisplayName(conversation)}`,
  controlBadge?.label
].filter(Boolean).join(". ");
```

Replace the button’s existing `aria-label` with `conversationAriaLabel`.

- [ ] **Step 4: Render only the icon overlay inside the existing avatar wrapper**

After `ContactAvatar` inside `.conv-avatar-wrap`, add:

```tsx
{controlBadge ? (
  <span
    aria-hidden="true"
    className={`conversation-control-badge is-${controlBadge.kind}`}
    title={controlBadge.label}
  >
    {controlBadge.kind === "attention" ? <TriangleAlert size={12} /> : null}
    {controlBadge.kind === "human" ? <UserRound size={12} /> : null}
    {controlBadge.kind === "agent" ? <Bot size={12} /> : null}
  </span>
) : null}
```

Do not add a new card row or a visible label. Keep the existing `onClick` acknowledgement logic unchanged, so opening a red handoff card shows the persisted human-controlled state as blue.

- [ ] **Step 5: Add the overlay CSS**

Add these rules after `.conv-avatar-wrap` in `styles.css`:

```css
.conversation-control-badge {
  position: absolute;
  right: -3px;
  bottom: -3px;
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--color-surface-card);
  border-radius: var(--radius-full);
  color: #fff;
  box-shadow: 0 2px 5px rgba(22, 51, 40, 0.22);
}

.conversation-control-badge.is-attention { background: #dc2626; }
.conversation-control-badge.is-human { background: #1769aa; }
.conversation-control-badge.is-agent { background: #6941c6; }

.conversation-card.needs-human-attention .conversation-control-badge {
  border-color: #fff1f2;
}
```

The card has no `overflow: hidden`, so the 3 px overlay offset remains visible and does not alter its layout height.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```sh
pnpm --filter @prymeira-talk/web test -- conversation-display.test.ts
pnpm --filter @prymeira-talk/web typecheck
```

Expected: both commands succeed with no new TypeScript errors.

### Task 3: Verify the complete web package and visual behavior

**Files:**

- Modify: `apps/web/src/features/inbox/conversation-display.ts`
- Modify: `apps/web/src/features/inbox/conversation-display.test.ts`
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Run the web test suite**

Run:

```sh
pnpm --filter @prymeira-talk/web test
```

Expected: all existing web tests and the new control badge tests pass.

- [ ] **Step 2: Build the web application**

Run:

```sh
pnpm --filter @prymeira-talk/web build
```

Expected: TypeScript validation and Vite production build finish successfully.

- [ ] **Step 3: Check the cards at desktop and mobile widths**

Run the local web app and inspect a conversation card at desktop and a 375 px viewport. Confirm all of the following:

```text
- An unseen handoff retains the red card treatment and red alert overlay.
- Opening it removes the red treatment through the existing acknowledgement behavior and exposes the blue human overlay.
- An active autonomous agent uses the purple bot overlay.
- An agent-allowed conversation with no active agent shows no overlay.
- The card remains the same height; time, unread count, channel, owner line, and preview remain visible.
```

- [ ] **Step 4: Commit the implementation**

Run:

```sh
git add apps/web/src/features/inbox/conversation-display.ts apps/web/src/features/inbox/conversation-display.test.ts apps/web/src/features/inbox/InboxPage.tsx apps/web/src/styles.css docs/superpowers/plans/2026-09-21-inbox-control-badge.md
git commit -m "feat(inbox): show compact conversation control badge"
```

Expected: the commit contains only the compact control badge, its tests, and its implementation plan.
