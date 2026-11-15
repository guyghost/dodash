import assert from "node:assert/strict";
import { test } from "node:test";
import { P7LocalLedgerStore } from "./p7-prospective-ledger-store.mjs";
import { projectP7LocalBenchmarks } from "./p7-prospective-benchmarks.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const start = Date.UTC(2026, 9, 16), hour = 3_600_000;
const manifest = { purpose: "LOCAL_PREPARATION", campaignId: "joint", manifestSha256: "a".repeat(64), startAt: start,
  endAt: start + 180 * 86_400_000, sourceProfileId: "fixture", clockVerified: true };
const products = ["BTC-USD", "ETH-USD"];
const fixture = (failpoint, path = ":memory:", initialize = true) => {
  let now = start - 2;
  const store = new P7LocalLedgerStore(path, manifest, { now: () => now, failpoint });
  store.registerBenchmarks({ campaignId: "joint", commandId: "profile", event: { type: "REGISTER_BENCHMARK_PROFILE", sourceProfileId: "fixture",
    profileSha256: "b".repeat(64), quantityDecimals: { "BTC-USD": 2, "ETH-USD": 2 } } });
  now = start;
  store.applyCampaign({ campaignId: "joint", commandId: "begin", event: { type: "BEGIN_LOCAL_SIMULATION" } });
  const book = (productId, sequence = "2", price = 99) => ({ productId, sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence,
    requestedAt: now, receivedAt: now, sourceObservedAt: now, bids: [{ price, quantity: 200 }], asks: [{ price: 101, quantity: 200 }] });
  for (const productId of products) for (const type of ["EXPECT_BENCHMARK", "REQUEST_BENCHMARK", "OBSERVE_BENCHMARK_BOOK", "RESOLVE_BENCHMARK"])
    if (initialize || type === "EXPECT_BENCHMARK")
    store.applyBenchmarkEntry({ campaignId: "joint", commandId: `${productId}-${type}`, productId,
      event: type === "OBSERVE_BENCHMARK_BOOK" ? { type, book: book(productId, "1"), bodySha256: "c".repeat(64) } : { type } });
  const command = (type, scheduledAt = start, books = null) => ({ campaignId: "joint", commandId: `${scheduledAt}-${type}`, scheduledAt,
    event: type === "OBSERVE_MARK" ? { type, books } : { type } });
  const mark = (scheduledAt = start, missing = false, sequence = "2", price = 99) => {
    now = scheduledAt;
    store.applyJointMark(command("EXPECT_MARK", scheduledAt));
    store.applyJointMark(command("REQUEST_MARK", scheduledAt));
    return store.applyJointMark(command("OBSERVE_MARK", scheduledAt, Object.fromEntries(products.map((p) => [p, missing ? null : { book: book(p, sequence, price), bodySha256: "d".repeat(64) }]))));
  };
  return { store, mark, command, setNow: (at) => { now = at; } };
};
test("durable B&H marks share P7 time and never debit portfolios", () => {
  const f = fixture();
  try {
    const before = f.store.export().benchmarkEntries, receipt = f.mark();
    assert.equal(receipt.observation.consolidated.equity, 20_000);
    assert.equal(receipt.benchmarkObservation.consolidated.available, true);
    assert.equal(receipt.benchmarkObservation.asOf, receipt.observation.asOf);
    assert.deepEqual(f.store.export().benchmarkEntries, before);
    f.setNow(start + hour);
    assert.equal(f.store.benchmarkMarkCoverage().available, 1);
    assert.equal(projectP7LocalBenchmarks(f.store, start + hour).coverage.buyAndHold.available, 1);
    assert.equal(f.store.export().benchmarkMarkState.slots[String(start)].observation.consolidated.available, true);
  } finally { f.store.close(); }
});
test("cash P7 does not hide missing B&H proof; historical suspension is sticky", () => {
  const f = fixture();
  try {
    const receipt = f.mark(start, true);
    assert.equal(receipt.observation.consolidated.available, true);
    assert.equal(receipt.benchmarkObservation.consolidated.available, false);
    f.mark(start + hour, true);
    f.mark(start + 2 * hour, true);
    f.setNow(start + 2 * hour + 1);
    const safety = f.store.applyCampaign({ campaignId: "joint", commandId: "check", event: { type: "CHECK_LOCAL_SAFETY" } });
    assert.equal(safety.phase, "suspended");
    assert.ok(safety.reasons.includes("BENCHMARK_MARK_PROOF_GAP_EXCEEDED"));
    const pricing = f.store.commitCampaignPricing({ campaignId: "joint", commandId: "blocked-pricing", productId: "BTC-USD",
      candleClosedAt: start });
    assert.equal(pricing.allowed, false);
    f.mark(start + 3 * hour, false, "3");
    assert.equal(f.store.export().campaignState.phase, "suspended");
    assert.throws(() => f.store.applyMark(f.command("EXPECT_MARK", start + 4 * hour)), /USE_JOINT_MARK/);
  } finally { f.store.close(); }
});
test("uninitialized benchmarks stay unavailable and old P7 marks are never backfilled", () => {
  const f = fixture(undefined, ":memory:", false);
  try {
    for (const type of ["EXPECT_MARK", "REQUEST_MARK", "OBSERVE_MARK"])
      f.store.applyMark(f.command(type, start, { "BTC-USD": null, "ETH-USD": null }));
    const receipt = f.mark(start + hour);
    assert.ok(receipt.benchmarkObservation.marks.every((m) => !m.available && m.reason === "BENCHMARK_NOT_INITIALIZED"));
    assert.equal(f.store.export().benchmarkMarkState.slots[String(start)], undefined);
    const coverage = f.store.benchmarkMarkCoverage(start + 2 * hour);
    assert.equal(coverage.unobserved, 1); assert.equal(coverage.unavailable, 1);
  } finally { f.store.close(); }
});
for (const phase of ["beforeCommit", "afterCommit"]) test(`joint mark crash ${phase} preserves both paths atomically`, () => {
  const path = resolve(mkdtempSync(resolve(tmpdir(), "opencode", "p7-joint-")), "ledger.sqlite");
  const f = fixture(undefined, path);
  f.store.applyJointMark(f.command("EXPECT_MARK")); f.store.applyJointMark(f.command("REQUEST_MARK"));
  const before = f.store.export(); f.store.close();
  const books = Object.fromEntries(products.map((productId) => [productId, { bodySha256: "d".repeat(64), book: { productId,
    sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "2", requestedAt: start, receivedAt: start, sourceObservedAt: start,
    bids: [{ price: 99, quantity: 200 }], asks: [{ price: 101, quantity: 200 }] } }]));
  const command = f.command("OBSERVE_MARK", start, books);
  const script = `const {P7LocalLedgerStore} = await import(${JSON.stringify(new URL("./p7-prospective-ledger-store.mjs", import.meta.url).href)});
    const store = new P7LocalLedgerStore(${JSON.stringify(path)}, ${JSON.stringify(manifest)}, {now: () => ${start},
      failpoint: (p) => {if(p === ${JSON.stringify(phase)}) process.exit(73);}});
    store.applyJointMark(${JSON.stringify(command)}); process.exit(74);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 73, child.stderr);
  const reopened = new P7LocalLedgerStore(path, manifest, { now: () => start });
  try {
    if (phase === "beforeCommit") assert.deepEqual(reopened.export(), before);
    const receipt = reopened.applyJointMark(command);
    assert.deepEqual(reopened.applyJointMark(command), receipt);
    assert.equal(reopened.export().entries.filter((e) => e.schemaVersion === 8 && e.command.event.type === "OBSERVE_MARK").length, 1);
    assert.equal(reopened.export().benchmarkMarkState.slots[String(start)].observation.consolidated.available, true);
  } finally { reopened.close(); }
});
test("B&H drawdown alone does not change the frozen P7 stop criterion", () => {
  const f = fixture();
  try {
    const receipt = f.mark(start, false, "2", 1);
    assert.ok(receipt.benchmarkObservation.consolidated.equity < 10_000);
    assert.equal(f.store.export().campaignState.phase, "localObserving");
    assert.equal(f.store.export().campaignState.maxDrawdown, 0);
  } finally { f.store.close(); }
});
test("a regressed entry sequence is unavailable even while P7 is cash", () => {
  const f = fixture();
  try {
    const receipt = f.mark(start, false, "0");
    assert.equal(receipt.observation.consolidated.available, true);
    assert.equal(receipt.benchmarkObservation.consolidated.available, false);
  } finally { f.store.close(); }
});
test("a book from a different request cannot qualify B&H cash-independent evidence", () => {
  const f = fixture();
  try {
    f.store.applyJointMark(f.command("EXPECT_MARK")); f.store.applyJointMark(f.command("REQUEST_MARK"));
    const books = Object.fromEntries(products.map((productId) => [productId, { bodySha256: "d".repeat(64), book: { productId,
      sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "2", requestedAt: start + 1, receivedAt: start + 1, sourceObservedAt: start + 1,
      bids: [{ price: 99, quantity: 200 }], asks: [{ price: 101, quantity: 200 }] } }]));
    f.setNow(start + 1);
    const receipt = f.store.applyJointMark(f.command("OBSERVE_MARK", start, books));
    assert.ok(receipt.benchmarkObservation.marks.every((m) => !m.available && m.reason === "REQUEST_CHECKPOINT_MISMATCH"));
    assert.equal(receipt.observation.consolidated.available, true);
  } finally { f.store.close(); }
});
test("recovery of a joint request suspends, and committed observations replay before clock access", () => {
  const f = fixture();
  try {
    const receipt = f.mark();
    f.setNow(start + hour);
    f.store.applyJointMark(f.command("EXPECT_MARK", start + hour));
    f.store.applyJointMark(f.command("REQUEST_MARK", start + hour));
    assert.equal(f.store.applyCampaign({ campaignId: "joint", commandId: "recover", event: { type: "RECOVER_LOCAL" } }).phase, "suspended");
    const original = f.store.export().entries.find((e) => e.command?.event.type === "OBSERVE_MARK").command;
    f.setNow(Number.NaN);
    assert.deepEqual(f.store.applyJointMark(original), receipt);
  } finally { f.store.close(); }
});
test("freshness expiry of B&H rolls back even when P7 is cash", () => {
  let expire = false, f;
  f = fixture((phase) => { if (expire && phase === "beforeCommit") f.setNow(start + 5_001); });
  try {
    f.store.applyJointMark(f.command("EXPECT_MARK")); f.store.applyJointMark(f.command("REQUEST_MARK"));
    const before = f.store.export(); expire = true;
    const books = Object.fromEntries(products.map((productId) => [productId, { bodySha256: "d".repeat(64), book: { productId,
      sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "2", requestedAt: start, receivedAt: start, sourceObservedAt: start,
      bids: [{ price: 99, quantity: 200 }], asks: [{ price: 101, quantity: 200 }] } }]));
    assert.throws(() => f.store.applyJointMark(f.command("OBSERVE_MARK", start, books)), /MARK_EXPIRED_BEFORE_COMMIT/);
    assert.deepEqual(f.store.export(), before);
  } finally { f.store.close(); }
});
