# Context-first Villefer pilot

User approved implementation on 11 September, sequentially, without enabling a channel or sending messages. The change is opt-in through `behaviorConfig.conversationReasoning: "context_first_v1"`; existing agents are not migrated. New Villefer package imports carry the flag.

## Root causes and corrections

- Price, urgency and closure keyword shortcuts could answer before the model saw the conversation. For opted-in agents these are advisory signals; the model decides the next step. Explicit-human, missing-attachment and injection guards remain, as do human takeover and assisted-channel send guards.
- Conflicting checklist instructions encouraged reopening an ongoing seller negotiation. The prompt now prioritizes speaker ownership, stage and the latest message. Approved sources remain the authority for commercial claims, not model memory or past promises.
- A model can mistakenly rewrite the incoming message, including addressing the seller by name. The final request explicitly asks for the company's next reply to the external sender, without borrowing the addressee's name. It also forbids promising independent future work the agent cannot perform.
- A nested handoff reason was ignored by normalization. Valid nested reasons are now a fallback after existing direct/top-level reasons; malformed values are ignored.
- Runtime and assistant previously read only the latest 80 messages. Opted-in agents request the stored conversation up to 2,000 messages / 120,000 body characters and fail visibly above safety limits. No silent truncation is called a complete history. Missing Evolution imports, other conversations and unread media remain limitations.

## Verification before publication

Eight new failures reproduced before implementation (routing, full-history loading and nested reason). Latest local verification: 795 API tests passed; 10 PostgreSQL tests skipped because no test database is configured; typecheck, production bundle build and whitespace checks passed.

Real evaluation uses a separate process, a copy of the deployed module prefix without server bootstrap, read-only database adapters, the inactive test agent's configuration and the configured real provider. No runtime/action executor is called, no channel is activated, and proposed notes/actions are only evidence.

- Candidate 1: 16 service executions / 16 model calls / zero execution errors. Reviewer still found seller-name confusion and unsupported future contact promises; not approved.
- Candidate 2: 20 executions / 20 model calls / zero execution errors. Seller-name confusion cleared in three repetitions, but third-party contact promises remained; not approved for publication.
- Candidate 3: final request clarifies the agent cannot independently contact others or check later. Results and publication status must be appended only after actual review.

Candidate 3 completed 20 calls without execution errors, but one of three repetitions still promised third-party contact. Candidate 4 puts the capability boundary directly in the Portuguese company prompt: scope is the current conversation, not independently contacting others. It completed 20 executions / 20 model calls with zero execution errors. All 20 replies and all nonempty proposed actions were inspected. The targeted continuity/identity errors were absent in the three repetitions of each C006 case; seller-negotiation replies C094 preserved deadline/payment as preferences. C108 asked for missing order details without inventing a price or forcing immediate transfer. Nested handoff reasons were retained in actual model output.

Not a claim of perfect dialogue: an alternative-thickness order still invited a potentially avoidable choice question; an uncertain finish invited more qualification. Supplier/region handoffs remain proposed work for a human, not verified routing or executed transfers. Pilot remains supervised; unprocessed historical context/media queues are unchanged.

## Publication record

API image built successfully in workflow `34610976028` for commit `ea9ef396cca488fb4b47d0ef153e3a6acef6324f` (implementation commit `039e7d17636644e59e5f791d656207ffb86cf570`). Only the API image field was updated in Portainer, not the stale stack editor, web, environment or database schema. New-container verification and deployed smoke results are pending below.

Only the inactive test agent received the new prompt and opt-in flag. Prompt SHA-256: `239a9f7c1ac2a64226c2f77a4fd229f455d29e29fe16cd8e2be0ab0d9cfc31f5`. Other-agent and channel hashes matched before/after the write. Original configuration and all four private candidate result sets were archived and hash-verified before rollout; recovery instructions are in the private monitoring README. No customer sends or real handoffs were invoked.

Published verification completed: task `zh2nrsd9fz7jtcmi7yx6hxc3f`, container `210d15a8ff79cfdf81d4ead3875b85da363c975a3bd8d2df7d07c344d81211a9` running. Bundle SHA-256 matched the locally verified build: `1d3b2ee73014410f593f27b67c11d3855ad0fde434f459ca257d93c041ba509a`. Both `/api/health` and `/api/ready` returned HTTP 200 and `ok:true, product:talk` after replacement.

Eight deployed-service smoke cases completed: five historical inputs reached the actual configured model; three hard guards did not invoke it. C094 deadline/payment continued the negotiation without new logistics questions or approved-condition claims. C006 attribution/thanks did not address the seller as the contact or promise third-party outreach. C108 asked missing profile/quantity instead of a canned price handoff. Explicit human request proposed handoff; injection did not disclose instructions; missing attachment requested resend. Replies and actions were reviewed, without invoking send/action execution. A quoting error in the first verification-script transfer was corrected; it was a harness parse error before any test or database operation, not an API failure.

Final local verification for the published source: 795 tests passed, 10 database-dependent tests skipped; typecheck and production build passed. No schema migration or image cleanup was required/performed. Keep existing images and archived evidence for rollback. Browser/cellphone end-to-end testing and actual routing destinations remain under the user's control.

Full replay inputs/results stay in private evaluation artifacts; none are committed here. Execution counts are not global approval rates. This work does not certify all weekly messages, all attachments or autonomous operation. The initial pilot requires seller review.
