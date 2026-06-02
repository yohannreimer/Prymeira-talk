# Meta Official Via Evolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Prymeira Talk send official Meta template campaigns through an existing Evolution API official instance.

**Architecture:** Extend `meta_cloud` settings with a `connectionMode` field. Keep direct Meta behavior intact, and add a via-Evolution runtime path that uses the existing Evolution client plus a new `sendTemplate` method.

**Tech Stack:** TypeScript, Fastify, Prisma JSON settings, React/Vite, Vitest.

---

## File Map

- Modify `apps/api/src/modules/evolution/evolution.client.ts`: add `sendTemplate`.
- Modify `apps/api/src/modules/evolution/evolution.client.test.ts`: cover Evolution template payload and response parsing.
- Modify `apps/api/src/modules/settings/settings.routes.ts`: accept direct and via-Evolution Meta settings shapes.
- Modify `apps/api/src/modules/settings/settings.service.ts`: preserve new Evolution API key secret and validate complete active settings by mode.
- Modify `apps/api/src/modules/settings/settings.service.test.ts`: cover via-Evolution activation, masking, and preservation.
- Modify `apps/api/src/modules/meta/meta-runtime.ts`: expose connection mode and via-Evolution config.
- Modify `apps/api/src/modules/meta/meta-runtime.test.ts`: cover inactive/direct/via-Evolution runtime resolution.
- Modify `apps/api/src/modules/campaigns/campaigns.service.ts`: send Meta template campaigns through Evolution when configured.
- Modify `apps/api/src/modules/campaigns/campaigns.service.test.ts`: cover via-Evolution template send.
- Modify `apps/api/src/modules/campaigns/campaigns.routes.ts`: pass Evolution client into Meta campaign send service.
- Modify `apps/web/src/app/api.ts`: type settings payload.
- Modify `apps/web/src/features/settings/SettingsPage.tsx`: add mode selector and via-Evolution fields.
- Modify `apps/web/src/features/channels/ChannelsPage.tsx`: gate/create Meta official channel using direct or via-Evolution config.
- Modify `apps/web/src/features/campaigns/CampaignsPage.tsx`: treat direct and via-Evolution activation as Meta active.
- Modify `README.md`: document the via-Evolution option.

## Tasks

### Task 1: Add Evolution Template Client Support

- [ ] Add `SendTemplateInput` and `sendTemplate` to `EvolutionClient`.
- [ ] POST to `/message/sendTemplate/{instanceName}` with `{ number, name, language, components }`.
- [ ] Extract provider message id using the existing extractor.
- [ ] Add tests for payload, secret redaction, and provider message id parsing.

### Task 2: Add Meta Settings Mode

- [ ] Extend `meta_cloud` settings with `connectionMode: "direct" | "evolution_official"`.
- [ ] Direct mode validates current Meta fields.
- [ ] Via-Evolution mode validates `evolutionBaseUrl`, `evolutionApiKey`, and `evolutionInstanceName`.
- [ ] Mask and preserve `evolutionApiKey`.
- [ ] Add route/service tests for manager activation, invalid incomplete activation, and preservation.

### Task 3: Resolve Runtime By Connection Mode

- [ ] Extend Meta runtime to return `connectionMode`.
- [ ] Direct mode returns current Graph client details.
- [ ] Via-Evolution mode returns base URL, instance name, and an Evolution client.
- [ ] Keep direct Meta webhook/template sync active only for direct mode.

### Task 4: Send Meta Templates Through Evolution

- [ ] Extend campaign service options with `metaEvolution`.
- [ ] In `sendMetaTemplate`, use direct Meta if runtime is direct and use Evolution `sendTemplate` if runtime is via-Evolution.
- [ ] For via-Evolution, require a connected `meta_cloud` channel whose `providerKey` matches the Evolution instance name.
- [ ] Add campaign tests for success and failure.

### Task 5: Update Web UI

- [ ] Settings shows Direct/Via Evolution selector only when Meta is active.
- [ ] Direct mode shows current Meta fields.
- [ ] Via-Evolution mode shows Evolution Base URL, API key, and instance name.
- [ ] Sync templates button appears only for direct mode.
- [ ] Channels unlocks Meta official creation for either complete mode.
- [ ] Campaigns shows Meta template controls for either complete mode.

### Task 6: Verify And Document

- [ ] Run `pnpm --filter @prymeira-talk/api test -- evolution.client.test.ts settings.service.test.ts meta-runtime.test.ts campaigns.service.test.ts`.
- [ ] Run `pnpm --filter @prymeira-talk/web typecheck`.
- [ ] Run `pnpm -r typecheck`.
- [ ] Run `pnpm test`.
- [ ] Update README with "Meta oficial via Evolution".
- [ ] Run local smoke on `http://localhost:5176`.
