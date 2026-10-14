# P7 source candidate preparation — 2026-10-14

Offline preparation only. Coinbase Exchange L2 is a candidate, not a selected execution or closing-candle source. No new market request, deployment or campaign was run.

The adapter preserves the raw body and SHA-256, wire tuples, exact decimal sequence, product increments/minimums and three distinct timestamps. It uses the pure source model and existing P7 book gate; explicit clock/cache evidence is mandatory. HTTP Date and request no-store cannot establish those facts. Auction unknown/null/true, stale/future source time, invalid timelines, crossed/unordered books, insufficient required quantity, timeout and 429 reject qualification.

Official [book documentation](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-book) describes L2 as an aggregated full book; tuple size is not multiplied by order count. The [product documentation](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-single-product) supplies increments and minimums. Missing metadata rejects conservatively.

Archived diagnostic aggregation found **3 unique completed runs**, no duplicate files or conflicting runs in the tracked 2026-10-13 archives. The known pre-fix run `58048a42-1244-4cd8-ab41-b28ac8173cc1` is retained with exclusion provenance but excluded from availability counts: its 15 NETWORK_ERROR rows came from a workerd redirect:error harness failure before outbound requests. The diagnostic denominator is 2 valid completed runs. Conflicting duplicates invalidate aggregation and produce no availability groups. HTTP status counts preserve 429 separately; per-run candle coverage records request windows, expected latest start and missing/duplicate starts. No completed cron report is archived: cron execution evidence is **UNKNOWN**, not proof of zero runs. Quotes labelled last, mid-or-last or book-mid remain diagnostic prices and cannot establish full execution-book eligibility. The JSON report retains provenance and separates candle readiness from quote kinds.

Reproduce:

```sh
node --test docs/analysis/p7-source-diagnostics.test.mjs
node docs/analysis/p7-source-diagnostics.mjs docs/analysis/evidence-cloudflare-market-source-2026-10-13
npm --prefix models test
npm --prefix apps/market-source-probe test
cd apps/market-source-probe && node --test scripts/coinbase-l2-runtime-smoke.mjs
```

The fixture smoke bundles the actual adapter and model into workerd and checks qualification plus rejection with zero outbound calls. This validates offline runtime compatibility; live book access, production cache proof and upstream timestamp reliability remain unverified. No persisted source profile or ledger transition is created.
