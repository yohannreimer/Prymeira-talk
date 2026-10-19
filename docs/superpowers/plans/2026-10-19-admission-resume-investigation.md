# Isolated admission / resume investigation

Inline only, no subagents. No production connections or pending replay. Temporary branch and Actions publication already authorized by user.

Preserve the previous 12-slot comparison and failure. First diagnostic: three predeclared slots C recovery enabled, D enabled, D disabled; C is original 4c718 runtime, D is an instrumented copy of C, not a release candidate. Same 160 offers, CPU/RAM, schema and owned services. D records per-request phase boundaries, transaction acquisition/work durations, SQL duration categories without SQL/parameters, event-loop lag, CPU and cgroup throttling. Record modified-source patch anchors; do not equate D bundles with production. No live credentials or customer data.

All slots sample only fixture connection lease/cursor/backoff/checkpoints every second and save a final snapshot even after timeout. Suspend the media-only Evolution fixture beyond the complete test deadline so it cannot poll nonexistent history endpoints. Retain the previous fixture-only rescheduling to observe its possible race with active cleanup; do not hide it by raising limits or timeouts.

Analyze first. Any runtime fix needs a specific reproduction and focused regression before broader validation. Backpressure32, durable-before-202, source fences, canonical tuple/tenant identity, bounded recovery and conservative sends remain required. Diagnostic workflow is not deployable release workflow. No deployment is authorized.


Diagnostic run39327820875 completed 3/3 slots: C147/160 admitted, instrumented C144/160 on and137/160 off; all accepted durable/applied, all recovery/restart oracles completed. Instrumented ingress authentication p50~207ms while pure secret checks use no DB; pool callback acquisition p50~202ms; publish phase p50~1000ms. Cgroup throttling observed. Instrumented worker advisory waits p95~674ms. These are observations, not a full explanation of all latency.

Minimal first fix E=da7a017: Evolution/WAHA authenticate raw bytes before acquiring SQL; Meta credential transaction unchanged; stage reauthentication, source ownership/generation fences and durable-before-202 untouched. Meaningful red/green: database unavailable plus invalid static credentials previously503, now401 without a DB call. Local28 tests pass. Added characterization proves cleanup pool failure retains a finite120s lease, prevents early provider I/O and safely resumes after actual expiry with original cursor/checkpoint.

Second fixed experiment: C on, E on, E off, C off (unmodified images, no instrumentation overhead), same quotas/load. Natural recovery eligibility observed; no WAHA due/lease reset. Deadline derives from persisted lease/backoff eligibility plus45s for30s cadence and bounded work, minimum90s and hard300s ceiling. Save eligibility/budget/final state; a new failure does not extend the wait indefinitely. This corrects the fixture assumption without certifying the previous missing final state. Ten real-SQL/transport/canonical/recovery suites run serially with zero-skip check before comparison. No production changes; diagnostic workflow remains non-deployable.
