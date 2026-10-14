# Review — P7 shadow runner

Status: awaiting independent root review before implementation.

Review checklist:
- Existing local fixture ledger purpose is never relabeled prospective.
- Prospective lifecycle separate; deployment activation disabled.
- REQUEST durable before I/O; recovery suspends without refetch.
- Transaction owns validation, receipt, journal, projection and outbox.
- B&H independent of HOLD; after-fill priority; final mark and T1 exclusion.
- R2 retry exact fixed bytes/key and explicit lack of independent anchor.
- Real local workerd persistence tests and official Cloudflare API references.

Root review: approved for implementation with conditions (2026-10-14): keep
LOCAL_PREPARATION engine and prospective lifecycle separate and fail closed;
prospective economic execution remains gated/unshipped. Deliver actual local
P7 decisions, independent benchmark, marks/checkpoints and SQLite/R2. Bound
catch-up work by pages; avoid journal replay for each command. Enforce monotonic
time and immutable code/protocol/source/authority scope; never mint authority
from unauthenticated ingress. All default I/O remains disabled.

Implementation review responses: source requests include exact raw response
hash, fresh use clocks and bounded timeout; commit revalidates model safety and
economic projections inside transaction. Captured FINAL is distinct from a
lost REQUEST. Route identity binds the R2 prefix. Actual alarms persist clock
mapping/next wake, page catchup, and retry the R2 outbox. Suspended state skips
economic jobs but retains diagnostic/reconciliation work. J30/J90 snapshots
freeze journal prefix plus projection; reports do not consume later state.
Projection/checkpoint rows are chunked. Full-retention workerd economic load is
explicitly unverified; planner enumeration is not that performance evidence.

Root preapproved remediation of final review P1s preserving existing guards:
content-addressed UTF-8-bounded capture/chunk export; explicit suspension for
crash at admitted decision boundary; terminal scheduler receipts retaining
unresolved ledger evidence after deadline/recovery, with no past-time deferral.
Verify through actual workerd crash boundaries and real SQLite row-size tests.
Root follow-up review required streaming bounds and shared header/body timeout.
Implemented fixed-size body buffer and explicit incomplete-prefix provenance;
actual workerd fast-headers/stalled-body fixture verifies five-second completion.
