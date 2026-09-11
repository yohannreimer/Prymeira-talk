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

Full replay inputs/results stay in private evaluation artifacts; none are committed here. Execution counts are not global approval rates. This work does not certify all weekly messages, all attachments or autonomous operation. The initial pilot requires seller review.
