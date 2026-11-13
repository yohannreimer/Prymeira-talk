# Junior follow-up audio and order context

Authorized by Yohann on 2026-11-11 after the review of all 48 pending records.

Goal: read seller and customer audio before analysing follow-ups and preserve the specifications and state of each distinct request. Keep cadence, approval mode and live attendance unchanged. Never send customer messages during validation.

Architecture: reuse the inbox transcription job and its durable cache through a shared transcriber injected into the attendance follow-up runtime. Prepare at most eight missing audio transcripts per run; continue a successful backlog in another claimed run. If any attempted audio remains unreadable, clear the draft and require review instead of guessing. Feed the prepared text to both analyst and writer. Preserve original sender and message IDs. No database migration or new credentials.

Order handling: strengthen the existing analyst, writer and reviewer instructions. Keep requests and quote versions separate; never transfer thickness, quantity, finish or commercial conditions between them. A newer request does not cancel unrelated older opportunities. Apply explicit unavailability only to the affected item; preserve an offered but unaccepted alternative as a separate decision. Internal search for an alternative is not a confirmed quote.

- [ ] Add failing runtime tests for seller/customer audio, cached text, unreadable/missing transcriber, batching and unchanged cadence/approval.
- [ ] Implement audio preparation and share existing app transcriber with the harness route.
- [ ] Add the order rules to analyst/writer/reviewer; add anonymized regression fixtures for the four failures and representative valid cases.
- [ ] Run targeted tests, API typecheck, full unit validation and builds. Verify the new tests fail against the previous implementation.
- [ ] Replay the error/control cases with the actual configured provider, without production delivery or conversation mutations.
- [ ] Publish an immutable revision after checks, deploy through the existing authorized Portainer workflow if accessible, and verify the active image and runtime wiring. Keep existing pending drafts under review; do not bulk-send or silently approve them.
- [ ] Save factual brain/editorial receipts with only engineering evidence, no customer transcripts or credentials. Report observed publication/deployment status precisely.

Use inline execution. The design follows the solution already proposed in chat and explicitly approved by Yohann; no additional approval gate is needed.
