# P7 source profile review

Model reviewed locally against existing P7 eligibility gate and Coinbase official REST documentation. Scope is pure offline qualification and archived diagnostics; no new state transition requires an XState actor. Explicit inputs avoid inferring clock/cache/product constraints. Rejection is conservative for unknown auction/source time/cache. Decimal sequence is extracted losslessly before JSON numeric parsing. Depth is explicit base quantity, checked on both sides. Existing ticker diagnostics remain last-price diagnostics only.

Pending independent root review before implementation. Acceptance requires the normative contract, offline-only scope, no final provider choice and raw evidence preservation.

Root independent review approved implementation on 2026-10-14: offline candidate only, fixed endpoint identity, conservative duplicate key rejection including nested sequence ambiguity. HTTP Date and client no-store never prove upstream freshness or UNCACHED. Archives remain immutable.

Root diagnostic review refinement: keep known pre-fix invalid workerd harness run excluded from provider availability denominator with provenance; conflicting duplicates invalidate aggregation (no first-wins choice). Preserve 429 counts and per-run archived request/expected candle windows plus missing/duplicate coverage. Root directed and approved these refinements before implementation.

PR #25 review refinement (2026-10-15): confirmed that Date.parse accepts impossible dates and host-dependent timezone-less strings, and that JSON.stringify insertion order creates false archive conflicts. Root reviewed and approved the model before implementation: validate Gregorian RFC3339 fields with an explicit timezone, and compare recursive JSON values with sorted object keys while retaining array order. Invalid timestamps retain raw/hash evidence but never qualify; genuinely changed report values remain fatal conflicts.
