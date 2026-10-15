# P7 shadow collector — Worker durable local preparation

Status: normative proposal for review; no deployment or prospective activation authorized.

## Scope and authority

The collector owns one SQLite Durable Object per campaign and an R2 export binding.
Its default capability is LOCAL_PREPARATION. Synthetic fixtures are accepted only
through an explicitly injected local market service; they can never create real
prospective evidence. Registration binds immutable campaign identity, manifest,
source qualification, authority and code/protocol fingerprints. A future prospective
activation additionally requires an enabled deployment capability, qualified source
profile, operator start authority and a preregistered future UTC-midnight T0. The
shipping configuration disables activation. No exchange order or LLM is involved.

## Model and events

A separate XState lifecycle is registered → preflight → ready → observing →
assessing → completed. PREFLIGHT records validated prerequisites; READY requires
all prerequisites; START requires matching authority and now in [T0,T1).
LOCAL_PREPARATION cannot satisfy START. PROOF_GAP and recovered pending requests
move observing to suspended; STOP moves observing/suspended to stopped;
INVARIANT_BREACH moves any nonterminal phase to invalid. PERIOD_ENDED moves
observing/suspended/stopped to assessing at T1; ASSESSMENT_COMMITTED completes.
There is no automatic recovery from suspended and no resurrection of terminal
states. A separate local simulation projection uses the existing local campaign
machine and is never presented as prospective observing.

The pure runner selects deterministic jobs from persisted projections. Daily slots
for both BTC-USD and ETH-USD are materialized even if HOLD or market failure.
Independent B&H entries occur at T0 even when P7 HOLDs. Priority is pending
AFTER_FILL joint marks, B&H entry, due hourly/final marks, then P7 pricing/daily
work; a pending after-fill mark forbids further P7 pricing. Checkpoints J30/J90
are descriptive; J180 is final. T1 forbids new fills. FINAL acquisition is requested before T1 (in the final
5 seconds), captures the pre-T1 book durably, and observes at T1 using the
existing final freshness gate. No book fetched at T1 is eligible. The existing V5/V7/V8/V9
models remain authoritative for book freshness (5 s inclusive), entry windows
(2 h inclusive, T1 exclusive), pricing, portfolios, joint marks and assessments.

## Durable protocol and effects

Every command has a deterministic campaign-scoped ID and canonical payload.
Duplicate ID+payload returns the original receipt; different payload conflicts.
A SQLite synchronous transaction validates against current state, appends a
sequence-numbered hash-chained journal record and updates the projection plus
export outbox together. No external I/O occurs inside that transaction.

Each source request is durably REQUESTED before source I/O. The request identity,
intent and portfolio snapshot are immutable. The response is captured once;
pricing uses the persisted response and fixed intent. A reboot that finds a
REQUESTED job without a captured response durably suspends the local/prospective
projection and never refetches that request. An ordinary transient market failure
is recorded as unavailable/rejected, not silently retried with a better price.
Alarms are duplicate-safe wakeups; durable job identity prevents duplicate fills.
The scheduling projection persists next wake time; overdue expected slots remain
visible and become missed/unobserved according to the existing gates.

R2 export keys are fixed campaign/sequence/hash paths under p7-shadow/v1/.
An outbox row stores exact bytes and hash before put. Retrying the same export
writes identical bytes under the same key; acknowledgement is persisted only
after success. A crash between put and acknowledgement safely retries. R2 failure
does not erase or rewrite journal facts. The hash chain and R2 are integrity and
transport evidence, not an independent immutable timestamp/anchor.

## Interfaces and verification

Worker environment: campaign Durable Object namespace, R2 bucket, optional
explicit local fixture service; activation disabled by default. HTTP ingress
validates campaign IDs and commands; no arbitrary URLs, credentials or market
fallbacks. Persistence uses DurableObjectState.storage.sql and transactionSync,
not node:sqlite. Network effects sit behind typed source/export interfaces.

Verification uses actual local workerd/Miniflare, persistent SQLite and R2,
restart, duplicate alarm/command, interrupted request recovery, failed export
and idempotent retry. Tests use explicit fake market service only; no fake DO
storage. Boundary tests cover 5 s, 2 h and T1. Successful local verification is
not source qualification, prospective collection, deployment or activation.

## Reviewed recovery/capture amendment (2026-10-14)

Raw evidence <=1 MiB UTF-8 is preserved in content-addressed bounded SQL chunks,
with hash, byte count and compact journal reference bound to CAPTURE atomically.
Normalized JSON has a separate 256 KiB UTF-8 budget. Oversized or invalid input
records a bounded rejection/hash/size, never embeds oversized raw in journal.
Captured chunks export before referencing journal pages and retain retry status.

A reboot at ADMITTED before any durable decision is an explicit unresolved
local proof gap: suspend, retain admission timestamp and exact captured candles,
never fabricate HOLD/INTENT or fetch again. Any nonterminal non-expected daily
phase after its 2h/T1 deadline, or under suspended recovery, is durably marked
job-complete UNRESOLVED with the ledger phase retained for assessment. No guessed
fill or successful terminal slot is synthesized. Expected expired slots still
use existing MISSED guard. No deferral deadline may be <= its recorded time.

Streaming refinement: read into a fixed 1 MiB byte buffer; stop at the first
chunk exceeding the budget. A single 5-second deadline covers fetch headers
and every stream read. Rejected incomplete streams record bodyComplete=false,
rawBytesScope=OBSERVED_LOWER_BOUND and hash of at most 64KiB prefix; rawSha256 is
null. Only a fully consumed response gets a whole-body rawSha256. Accepted
UTF-8 raw bytes preserve Unicode/surrogate boundaries and optional BOM exactly.

## Review amendment (2026-10-15)

Registration requires all three target-exposure absolute caps >= $1 billion and
cooldownMs=0, in addition to structurally valid risk settings. These are experiment
invariants, not tunable economics. A recovered hourly REQUESTED without CAPTURE
gets a terminal scheduler receipt RESPONSE_UNOBSERVED_AT_RECOVERY; its requested
mark stays unresolved, the campaign stays suspended, and no request is repeated.
A repeated PREFLIGHT returns its persisted command before lifecycle validation.
J30/J90 freeze the last committed observation at or before their cutoff, never
late catchup observations; the assessment denominator remains 60/180 slots even
when expectations were not observed in time. Future wakeup work cannot rewrite it.
