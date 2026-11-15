import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { P7LocalLedgerStore } from "./p7-prospective-ledger-store.mjs";
import { projectP7LocalBenchmarks } from "./p7-prospective-benchmarks.mjs";
const start = Date.UTC(2026, 9, 16);
const manifest = { purpose: "LOCAL_PREPARATION", campaignId: "independent-fixture", manifestSha256: "a".repeat(64),
  startAt: start, endAt: start + 180 * 86_400_000, sourceProfileId: "fixture", clockVerified: true };
const command = (type, productId = "BTC-USD", override = {}, id = `${productId}-${type}`) => ({ campaignId: manifest.campaignId,
  commandId: id, productId, event: type === "OBSERVE_BENCHMARK_BOOK" ? { type, bodySha256: "c".repeat(64), book: {
    productId, sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "1", requestedAt: start, receivedAt: start + 1, sourceObservedAt: start + 1,
    bids: [{ price: 99, quantity: 200 }], asks: [{ price: 101, quantity: 200 }], ...override,
  } } : { type, ...override } });
const temporary = () => {
  const preferred = resolve(tmpdir(), "opencode");
  return resolve(mkdtempSync(resolve(existsSync(preferred) ? preferred : tmpdir(), "p7-bh-entry-")), "ledger.sqlite");
};
const fixture = (path = ":memory:", failpoint) => {
  let now = start - 2;
  const store = new P7LocalLedgerStore(path, manifest, { now: () => now, failpoint });
  store.registerBenchmarks({ campaignId: manifest.campaignId, commandId: "profile", event: { type: "REGISTER_BENCHMARK_PROFILE",
    sourceProfileId: "fixture", profileSha256: "b".repeat(64), quantityDecimals: { "BTC-USD": 2, "ETH-USD": 2 } } });
  now = start; store.applyCampaign({ campaignId: manifest.campaignId, commandId: "begin", event: { type: "BEGIN_LOCAL_SIMULATION" } });
  const quote = (productId = "BTC-USD", override = {}) => {
    now = Math.max(now, start);
    store.applyBenchmarkEntry(command("EXPECT_BENCHMARK", productId)); store.applyBenchmarkEntry(command("REQUEST_BENCHMARK", productId));
    const requestedAt = now; now++;
    return store.applyBenchmarkEntry(command("OBSERVE_BENCHMARK_BOOK", productId, { requestedAt, receivedAt: now, sourceObservedAt: now, ...override }));
  };
  return { store, quote, path, setNow: (at) => { now = at; } };
};
test("P7 HOLD initializes both B&H products without P7 intents or fills", () => {
  const f = fixture();
  try {
    for (const productId of ["BTC-USD", "ETH-USD"]) {
      f.setNow(start);
      for (const event of [{ type: "EXPECT" }, { type: "ADMIT", evaluatedAt: start, windowSha256: "d".repeat(64) }, { type: "TERMINATE", outcome: { kind: "HOLD" } }])
        f.store.apply({ campaignId: manifest.campaignId, commandId: `${productId}-${event.type}`, productId, candleClosedAt: start, event });
    }
    for (const productId of ["BTC-USD", "ETH-USD"]) {
      f.quote(productId); f.store.applyBenchmarkEntry(command("RESOLVE_BENCHMARK", productId));
    }
    const report = projectP7LocalBenchmarks(f.store, start + 2);
    assert.equal(report.buyAndHold.entryMode, "INDEPENDENT_DURABLE");
    assert.equal(report.buyAndHold.initializationComplete, true);
    assert.equal(f.store.export().state.portfolios["BTC-USD"].positionQuantity, 0);
    assert.equal(f.store.export().state.portfolios["ETH-USD"].cash, 10_000);
  } finally { f.store.close(); }
});
test("first eligible book cannot be replaced when depth is insufficient", () => {
  const f = fixture(); f.quote("BTC-USD", { asks: [{ price: 101, quantity: 1 }] });
  try {
    assert.throws(() => f.store.applyBenchmarkEntry(command("REQUEST_BENCHMARK", "BTC-USD", {}, "better-request")), /INVALID_BENCHMARK_ENTRY_PHASE/);
    const receipt = f.store.applyBenchmarkEntry(command("RESOLVE_BENCHMARK"));
    assert.equal(receipt.phase, "failed"); assert.equal(receipt.reason, "INSUFFICIENT_DEPTH");
    assert.equal(receipt.portfolio, null);
  } finally { f.store.close(); }
});
test("a requested response lost across reopening suspends campaign on explicit recovery", () => {
  const f = fixture(temporary());
  f.store.applyBenchmarkEntry(command("EXPECT_BENCHMARK")); f.store.applyBenchmarkEntry(command("REQUEST_BENCHMARK")); f.store.close();
  const reopened = new P7LocalLedgerStore(f.path, manifest, { now: () => start + 1 });
  try {
    assert.equal(reopened.benchmarkRecovery("BTC-USD").action, "SUSPEND");
    assert.equal(reopened.applyCampaign({ campaignId: manifest.campaignId, commandId: "recover", event: { type: "RECOVER_LOCAL" } }).phase, "suspended");
    assert.throws(() => reopened.applyBenchmarkEntry(command("REQUEST_BENCHMARK", "BTC-USD", {}, "refetch")), /INVALID_BENCHMARK_ENTRY_PHASE/);
  } finally { reopened.close(); }
});
test("expiry before COMMIT rolls back the purchase, retry fails the same frozen quote", () => {
  let expire = false, f;
  f = fixture(":memory:", (phase) => { if (expire && phase === "beforeCommit") f.setNow(start + 5_002); }); f.quote();
  try {
    const before = f.store.export(); expire = true;
    assert.throws(() => f.store.applyBenchmarkEntry(command("RESOLVE_BENCHMARK")), /PRICING_EXPIRED_BEFORE_COMMIT/);
    assert.deepEqual(f.store.export(), before);
    expire = false;
    assert.equal(f.store.applyBenchmarkEntry(command("RESOLVE_BENCHMARK")).reason, "STALE_AT_USE");
  } finally { f.store.close(); }
});
for (const crashPhase of ["beforeCommit", "afterCommit"]) test(`B&H purchase survives process exit ${crashPhase} without duplicate debit`, () => {
  const f = fixture(temporary()); f.quote(); const before = f.store.export(); f.store.close();
  const script = `const { P7LocalLedgerStore } = await import(${JSON.stringify(new URL("./p7-prospective-ledger-store.mjs", import.meta.url).href)});
    const store = new P7LocalLedgerStore(${JSON.stringify(f.path)}, ${JSON.stringify(manifest)}, {
      now: () => ${start + 1}, failpoint: (phase) => { if (phase === ${JSON.stringify(crashPhase)}) process.exit(73); }
    }); store.applyBenchmarkEntry(${JSON.stringify(command("RESOLVE_BENCHMARK"))}); process.exit(74);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 }); assert.equal(child.status, 73, child.stderr);
  const reopened = new P7LocalLedgerStore(f.path, manifest, { now: () => start + 1 });
  try {
    if (crashPhase === "beforeCommit") assert.deepEqual(reopened.export(), before);
    const receipt = reopened.applyBenchmarkEntry(command("RESOLVE_BENCHMARK"));
    assert.deepEqual(reopened.applyBenchmarkEntry(command("RESOLVE_BENCHMARK")), receipt);
    assert.equal(reopened.export().entries.filter((e) => e.command?.event?.type === "RESOLVE_BENCHMARK").length, 1);
  } finally { reopened.close(); }
});
test("an invalid book can be followed by one eligible book, but never replace that eligible price", () => {
  const f = fixture(); f.quote("BTC-USD", { cacheStatus: "UNKNOWN" });
  try {
    f.setNow(start + 2);
    f.store.applyBenchmarkEntry(command("REQUEST_BENCHMARK", "BTC-USD", {}, "request-2"));
    f.setNow(start + 3);
    f.store.applyBenchmarkEntry(command("OBSERVE_BENCHMARK_BOOK", "BTC-USD", { requestedAt: start + 2, receivedAt: start + 3, sourceObservedAt: start + 3,
      asks: [{ price: 102, quantity: 200 }] }, "book-2"));
    const receipt = f.store.applyBenchmarkEntry(command("RESOLVE_BENCHMARK"));
    assert.equal(receipt.fill.price, 102 * 1.0002);
    assert.equal(receipt.attempt, 2);
    f.setNow(manifest.endAt + 1);
    assert.deepEqual(f.store.applyBenchmarkEntry(command("RESOLVE_BENCHMARK")), receipt);
    assert.throws(() => f.store.applyBenchmarkEntry(command("RESOLVE_BENCHMARK", "BTC-USD", {}, "second-buy")), /INVALID_BENCHMARK_ENTRY_PHASE/);
  } finally { f.store.close(); }
});
test("a legacy initial mark cannot be used to choose a new entry mode afterward", () => {
  const f = fixture();
  try {
    for (const type of ["EXPECT_MARK", "REQUEST_MARK", "OBSERVE_MARK"]) f.store.applyMark({ campaignId: manifest.campaignId, commandId: type, scheduledAt: start,
      event: type === "OBSERVE_MARK" ? { type, books: { "BTC-USD": null, "ETH-USD": null } } : { type } });
    assert.throws(() => f.store.applyBenchmarkEntry(command("EXPECT_BENCHMARK")), /BENCHMARK_MODE_ALREADY_OBSERVED/);
    assert.equal(f.store.export().benchmarkEntries.active, false);
  } finally { f.store.close(); }
});
