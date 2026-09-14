# Inbox contact/history corrections implementation plan

> Execute sequentially using executing-plans; preserve unrelated experimental changes in the pilot checkout.

**Goal:** wait five seconds for a message burst, make contact naming editable in the inbox, and recover only safely attributable five-day history.

**Architecture:** retain the existing ten-second burst cap and manual-send guard. Add a small contact identity editor using the existing authenticated PATCH contact API and contact.updated events. Diagnose historical LID mappings before importing; never infer a phone from a name or LID digits. No migrations, autonomy changes, or experimental runtime deployment.

**Tech Stack:** React/TypeScript, Vitest, Prisma, Evolution, Portainer.

## Delay

- [ ] Change policy test to `expect(nextSuggestionAt(1000,1000)).toBe(6000)` and add restarted-window case `nextSuggestionAt(1000,4000) === 9000`; retain cap case 11000.
- [ ] Run `pnpm --filter @prymeira-talk/api test -- src/modules/assistant/assistant-policy.test.ts`; observe red.
- [ ] Replace only `lastInboundMs+2000` with `lastInboundMs+5000` in assistant-policy.ts; rerun green.

## Contact editing

- [ ] Create ContactIdentityCard and tests for visible name, phone, accessible Edit name, escaped data, input max length, loading and error states.
- [ ] Integrate the component keyed by contactId in InboxPage. Persist `{name}` through apiUpdateContact; update matching conversations using the returned contact, not current selection. Keep existing channel label, styling and contact.updated handling.
- [ ] Verify saving, cancellation, blank-name validation, failed save retention, changing conversations, and preservation of composer draft. Never overwrite manual names with provider names.
- [ ] Run web tests/typecheck/build and verify the editor visually with local test data; do not rename a real customer just for testing.

## Historical data diagnosis and recovery

- [ ] Inspect source snapshot identity fields and prove original/new instance number ownership. Try exact provider message IDs plus timestamp/direction/content equality across the same WhatsApp number to establish missing LID/phone aliases.
- [ ] Dry-run additional mappings; reject conflicting mappings or destinations. Enrich blank names only from explicit provider contact mappings or inbound pushName of a proven identity.
- [ ] Import only approved five-day source rows with original dates, deduplication, no sends, no suggestion scheduling, no overwrites of existing conversation state. Record unresolved counts honestly.

## Release

- [ ] Run isolated full API/web/shared tests, typechecks and builds. Review diff for only scoped changes; commit and dispatch the existing image workflow on this branch.
- [ ] Record current API/web image versions and archive private operational history receipts before replacing containers. Publish/update only Talk images, no database schema migration required.
- [ ] Verify health/ready, persisted draft-only settings in both target channels, bundle delay, UI edit control, and historical counts. Record limitations and evidence in operations log.
