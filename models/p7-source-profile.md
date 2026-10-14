# P7 source profile: offline Coinbase Exchange L2 candidate

Status: normative offline qualification contract; candidate only, never a frozen source choice.

## Model

This lot adds a pure qualification projection, not an execution workflow. No network, actor, ledger transition, fill, or LLM is permitted. Existing `evaluateP7ExecutionBook` remains the state-independent execution evidence authority. Important collection workflow remains `marketSourceProbeMachine`.

Input is an archived response envelope: product identity, URL ending `/products/{product}/book?level=2`, HTTP status or explicit timeout, requestedAt, receivedAt, raw body, explicit clock verification, cache verification and product metadata. Raw UTF-8 body SHA-256 is computed and retained, including rejected evidence. Source time is read only from book `time`; receipt time never substitutes for it.

Sequence is captured from the raw JSON decimal token before numeric parsing, with one unique top-level sequence field, 1–64 canonical decimal digits. Unsafe JSON numbers must never round the sequence. String prices and aggregated quantities are retained in original order alongside numeric P7 projections; no sorting, quantity multiplication by num-orders or ticker substitution occurs.

Metadata preserves base_increment, quote_increment, base_min_size and min_market_funds as decimal strings. Missing or invalid metadata rejects qualification; metadata is explicit archived evidence, never guessed. Auction mode must be explicitly false; true, null and absent reject conservatively. A response without source time or explicit UNCACHED evidence rejects.

Qualification first rejects transport status (429, timeout, non-200), malformed JSON, identity/metadata/auction errors; it then delegates clock/cache/timeline/sequence/order/crossed-book validation to evaluateP7ExecutionBook. Inclusive boundaries: source age and round trip <=5,000ms, close-to-receipt <=7,200,000ms; campaign end remains exclusive. Additional depth requirement is explicit positive requiredBaseQuantity on each side; insufficient cumulative quantity rejects. Success means only OFFLINE_QUALIFIED evidence, not selected provider or executable authorization.

## Archived diagnostic aggregation

Read existing completed protocol market-source-probe-v1 reports only; deduplicate by runId, distinguish conflicting duplicates, classify observations by provider/product/kind/outcome, retain source file provenance. Candle coverage and diagnostic price kinds are reported separately. Last trade ticker never qualifies as L2 evidence. Report observed manual/cron trigger evidence only if explicit archived trigger exists; absent cron evidence is UNKNOWN, not zero scheduled executions. No new collection is authorized.

## Official wire sources

- https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-book (L2 aggregated tuples, sequence, time, auction_mode)
- https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-single-product (product increments and minimums)

## Verify

Run baseline model/probe tests, meaningful rejection matrix and exact 5s/2h boundaries, large decimal sequence preservation, immutable raw/hash provenance, ordered tuple preservation, archive deduplication/cron unknown checks, and offline workerd fixture smoke. No live probe/deploy/push.
