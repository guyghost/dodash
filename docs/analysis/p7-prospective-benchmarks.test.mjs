import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { P7LocalLedgerStore } from "./p7-prospective-ledger-store.mjs";
import { projectP7LocalBenchmarks } from "./p7-prospective-benchmarks.mjs";
const start = Date.UTC(2026, 9, 16), HOUR = 3_600_000;
const manifest = { purpose: "LOCAL_PREPARATION", campaignId: "bench-fixture", manifestSha256: "a".repeat(64),
  startAt: start, endAt: start + 180 * 86_400_000, sourceProfileId: "fixture", clockVerified: true };
const profile = { campaignId: manifest.campaignId, commandId: "profile", event: { type: "REGISTER_BENCHMARK_PROFILE", sourceProfileId: "fixture",
  profileSha256: "b".repeat(64), quantityDecimals: { "BTC-USD": 2, "ETH-USD": 2 } } };
const temporary = () => {
  const preferred = resolve(tmpdir(), "opencode");
  return resolve(mkdtempSync(resolve(existsSync(preferred) ? preferred : tmpdir(), "p7-bench-")), "ledger.sqlite");
};
const fixture = (path = ":memory:", register = true, failpoint) => {
  let now = start - 2;
  const store = new P7LocalLedgerStore(path, manifest, { now: () => now, failpoint });
  now = start - 1;
  if (register) store.registerBenchmarks(profile);
  const quote = (productId, asks = [{ price: 101, quantity: 200 }], at = start + 1) => {
    now = at;
    for (const event of [{ type: "EXPECT" }, { type: "ADMIT", evaluatedAt: now, windowSha256: "c".repeat(64) },
      { type: "INTENT", side: "BUY", quantity: 2, portfolioVersion: 0 }, { type: "REQUEST_QUOTE" },
      { type: "OBSERVE_QUOTE", bodySha256: "d".repeat(64), book: { productId, sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "1",
        requestedAt: now, receivedAt: now, sourceObservedAt: now, bids: [{ price: 99, quantity: 200 }], asks } }])
      store.apply({ campaignId: manifest.campaignId, commandId: `${productId}-${event.type}`, productId, candleClosedAt: start, event });
  };
  const mark = (scheduledAt = start, depth = 200) => {
    now = scheduledAt + 2;
    for (const type of ["EXPECT_MARK", "REQUEST_MARK", "OBSERVE_MARK"]) store.applyMark({ campaignId: manifest.campaignId, commandId: `${type}-${scheduledAt}`, scheduledAt,
      event: type === "OBSERVE_MARK" ? { type, books: Object.fromEntries(["BTC-USD", "ETH-USD"].map((productId) => [productId, { bodySha256: "e".repeat(64),
        book: { productId, sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: String(scheduledAt), requestedAt: now, receivedAt: now, sourceObservedAt: now,
          bids: [{ price: 99, quantity: depth }], asks: [{ price: 101, quantity: 200 }] } }])) } : { type } });
  };
  return { store, quote, mark, path, setNow: (at) => { now = at; } };
};
test("B&H uses initial published quotes and broker costs without touching P7 balances", () => {
  const f = fixture(); f.quote("BTC-USD"); f.quote("ETH-USD"); f.mark();
  try {
    const before = f.store.export(), report = projectP7LocalBenchmarks(f.store, start + HOUR);
    assert.equal(report.cash.equity, 20_000);
    assert.equal(report.buyAndHold.initializationComplete, true);
    for (const leg of Object.values(report.buyAndHold.products)) {
      assert.equal(leg.status, "INITIALIZED");
      assert.ok(leg.portfolio.cash >= 0);
      assert.equal(leg.fill.price, 101 * 1.0002);
      assert.equal(leg.fill.fee, leg.fill.price * leg.quantity * 0.006);
    }
    assert.equal(report.coverage.buyAndHold.available, 1);
    assert.deepEqual(f.store.export(), before);
  } finally { f.store.close(); }
});
test("one missing initial leg is pending then non-initialized, never a flat B&H mark", () => {
  const f = fixture(); f.quote("BTC-USD"); f.mark();
  try {
    assert.equal(projectP7LocalBenchmarks(f.store, start + HOUR).buyAndHold.products["ETH-USD"].status, "PENDING");
    const report = projectP7LocalBenchmarks(f.store, start + 2 * HOUR + 1);
    assert.equal(report.buyAndHold.initializationComplete, false);
    assert.equal(report.buyAndHold.products["ETH-USD"].status, "NOT_INITIALIZED");
    assert.equal(report.coverage.buyAndHold.available, 0);
    assert.equal(report.coverage.buyAndHold.unavailable, 1);
    assert.equal(report.coverage.buyAndHold.unobserved, 1);
  } finally { f.store.close(); }
});
test("insufficient entry depth stays failed even with later deep mark books", () => {
  const f = fixture(); f.quote("BTC-USD", [{ price: 101, quantity: 1 }]); f.quote("ETH-USD"); f.mark();
  try {
    const report = projectP7LocalBenchmarks(f.store, start + HOUR);
    assert.equal(report.buyAndHold.products["BTC-USD"].reason, "INSUFFICIENT_DEPTH");
    assert.equal(report.buyAndHold.initializationComplete, false);
  } finally { f.store.close(); }
});
test("B&H depth coverage differs from P7 known cash on the same mark evidence", () => {
  const f = fixture(); f.quote("BTC-USD"); f.quote("ETH-USD"); f.mark(start, 1);
  try {
    const report = projectP7LocalBenchmarks(f.store, start + HOUR);
    assert.equal(report.coverage.p7.available, 1);
    assert.equal(report.coverage.buyAndHold.available, 0);
    assert.equal(report.coverage.buyAndHold.unavailable, 1);
  } finally { f.store.close(); }
});
test("profile is durable, idempotent and immutable after registration", () => {
  const f = fixture(temporary()); const receipt = f.store.registerBenchmarks(profile); f.store.close();
  const reopened = new P7LocalLedgerStore(f.path, manifest, { now: () => start + 1 });
  try {
    assert.deepEqual(reopened.registerBenchmarks(profile), receipt);
    assert.throws(() => reopened.registerBenchmarks({ ...profile, commandId: "changed" }), /BENCHMARK_PROFILE_IMMUTABLE/);
    assert.throws(() => reopened.registerBenchmarks({ ...profile, event: { ...profile.event, quantityDecimals: { "BTC-USD": 3, "ETH-USD": 2 } } }), /COMMAND_ID_CONFLICT/);
    assert.equal(reopened.export().benchmarkProfile.quantityDecimals["BTC-USD"], 2);
  } finally { reopened.close(); }
});
test("unregistered or late profile is not a benchmark and never a real activation", () => {
  const f = fixture(":memory:", false); f.setNow(start);
  try {
    assert.throws(() => f.store.registerBenchmarks(profile), /INVALID_BENCHMARK_PROFILE/);
    assert.equal(projectP7LocalBenchmarks(f.store, start).buyAndHold.initializationComplete, false);
    assert.equal(f.store.export().campaignState.phase, "registered");
  } finally { f.store.close(); }
});
test("marks before the initial benchmark fills are not backfilled as invested equity", () => {
  const f = fixture(); f.mark(); f.quote("BTC-USD", undefined, start + 3); f.quote("ETH-USD", undefined, start + 3); f.mark(start + HOUR);
  try {
    const report = projectP7LocalBenchmarks(f.store, start + 2 * HOUR);
    assert.equal(report.buyAndHold.initializationComplete, true);
    assert.equal(report.buyAndHold.observations[0].consolidated.available, false);
    assert.equal(report.buyAndHold.observations[1].consolidated.available, true);
    assert.equal(report.coverage.buyAndHold.unavailable, 1);
    assert.equal(report.coverage.buyAndHold.available, 1);
  } finally { f.store.close(); }
});
test("profile registration crossing T0 rolls back, not an after-the-fact precision choice", () => {
  let expire = false, f;
  f = fixture(":memory:", false, (phase) => { if (expire && phase === "beforeCommit") f.setNow(start); });
  try {
    const before = f.store.export(); expire = true;
    assert.throws(() => f.store.registerBenchmarks(profile), /BENCHMARK_REGISTRATION_EXPIRED/);
    assert.deepEqual(f.store.export(), before);
  } finally { f.store.close(); }
});
