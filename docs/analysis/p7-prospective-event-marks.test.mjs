import assert from "node:assert/strict";
import { test } from "node:test";
import { P7LocalLedgerStore } from "./p7-prospective-ledger-store.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const start = Date.UTC(2026, 9, 16), end = start + 180 * 86_400_000;
const manifest = { purpose: "LOCAL_PREPARATION", campaignId: "event-marks", manifestSha256: "a".repeat(64),
  startAt: start, endAt: end, sourceProfileId: "fixture", clockVerified: true };
const products = ["BTC-USD", "ETH-USD"];
const fixture = (failpoint, activate = true, path = ":memory:") => {
  let now = start - 2;
  const store = new P7LocalLedgerStore(path, manifest, { now: () => now, failpoint });
  store.registerBenchmarks({ campaignId: manifest.campaignId, commandId: "profile", event: { type: "REGISTER_BENCHMARK_PROFILE",
    sourceProfileId: "fixture", profileSha256: "b".repeat(64), quantityDecimals: { "BTC-USD": 2, "ETH-USD": 2 } } });
  now = start;
  store.applyCampaign({ campaignId: manifest.campaignId, commandId: "begin", event: { type: "BEGIN_LOCAL_SIMULATION" } });
  for (const productId of products) store.applyBenchmarkEntry({ campaignId: manifest.campaignId, commandId: `expect-${productId}`, productId, event: { type: "EXPECT_BENCHMARK" } });
  store.applyJointMark({ campaignId: manifest.campaignId, commandId: "hourly-expect", scheduledAt: start, event: { type: "EXPECT_MARK" } });
  const event = (type, markId = "FINAL", extra = {}, commandId = `${markId}-${type}`) => ({ campaignId: manifest.campaignId, commandId, markId, event: { type, ...extra } });
  if (activate) store.applyEventMark(event("REGISTER_EVENT_MARKS"));
  const book = (productId, requestedAt = now, sequence = "2") => ({ productId, sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence,
    requestedAt, receivedAt: now, sourceObservedAt: now, bids: [{ price: 99, quantity: 200 }], asks: [{ price: 101, quantity: 200 }] });
  const buy = (productId) => {
    for (const type of ["REQUEST_BENCHMARK", "OBSERVE_BENCHMARK_BOOK", "RESOLVE_BENCHMARK"])
      store.applyBenchmarkEntry({ campaignId: manifest.campaignId, commandId: `${type}-${productId}`, productId,
        event: type === "OBSERVE_BENCHMARK_BOOK" ? { type, book: book(productId, now, "1"), bodySha256: "c".repeat(64) } : { type } });
  };
  const observe = (markId, missing = false, sequence = "2") => {
    store.applyEventMark(event("REQUEST_EVENT_MARK", markId));
    return store.applyEventMark(event("OBSERVE_EVENT_MARK", markId, { books: Object.fromEntries(products.map((p) => [p,
      missing ? null : { book: book(p, now, sequence), bodySha256: "d".repeat(64) }])) }));
  };
  return { store, event, book, buy, observe, setNow: (at) => { now = at; } };
};
test("benchmark bootstrap creates after-fill expectations without deadlocking the second leg", () => {
  const f = fixture();
  try {
    f.buy("BTC-USD");
    const slot = Object.values(f.store.export().eventMarkState.slots).find((s) => s.kind === "AFTER_FILL");
    assert.equal(slot.phase, "expected");
    f.buy("ETH-USD");
    assert.equal(f.observe(slot.markId).phase, "observed");
    const pending = Object.values(f.store.export().eventMarkState.slots).filter((s) => s.kind === "AFTER_FILL" && s.phase !== "observed");
    assert.equal(pending.length, 1);
    assert.equal(f.store.markCoverage(start + 3_600_000).available, 0);
  } finally { f.store.close(); }
});
test("all bootstrap marks must be available before P7 pricing is permitted", () => {
  const f = fixture();
  try {
    f.buy("BTC-USD"); f.buy("ETH-USD");
    const request = { campaignId: manifest.campaignId, commandId: "blocked-price", productId: "BTC-USD", candleClosedAt: start };
    assert.equal(f.store.commitCampaignPricing(request).reason, "AFTER_FILL_MARK_REQUIRED");
    for (const slot of Object.values(f.store.export().eventMarkState.slots).filter((s) => s.kind === "AFTER_FILL")) f.observe(slot.markId);
    for (const event of [{ type: "EXPECT" }, { type: "ADMIT", evaluatedAt: start, windowSha256: "e".repeat(64) },
      { type: "INTENT", side: "BUY", quantity: 2, portfolioVersion: 0 }, { type: "REQUEST_QUOTE" },
      { type: "OBSERVE_QUOTE", bodySha256: "f".repeat(64), book: f.book("BTC-USD", start, "3") }])
      f.store.apply({ campaignId: manifest.campaignId, commandId: `p7-${event.type}`, productId: "BTC-USD", candleClosedAt: start, event });
    assert.equal(f.store.commitCampaignPricing({ ...request, commandId: "fill-price" }).allowed, true);
    const slot = Object.values(f.store.export().eventMarkState.slots).filter((s) => s.kind === "AFTER_FILL").at(-1);
    assert.equal(slot.phase, "expected");
    const receipt = f.observe(slot.markId, false, "4");
    assert.equal(receipt.observation.consolidated.available, true);
    assert.equal(receipt.observation.portfolios["BTC-USD"].positionQuantity, 2);
    assert.equal(f.store.export().state.portfolios["BTC-USD"].positionQuantity, 2);
  } finally { f.store.close(); }
});
test("event-mark mode cannot be activated after an economic fill", () => {
  const f = fixture(undefined, false);
  try {
    f.buy("BTC-USD");
    assert.throws(() => f.store.applyEventMark(f.event("REGISTER_EVENT_MARKS", "FINAL", {}, "late-register")), /EVENT_MARK_MODE_NOT_READY/);
  } finally { f.store.close(); }
});
test("unavailable after-fill evidence is terminal and cannot be repriced", () => {
  const f = fixture();
  try {
    f.buy("BTC-USD"); f.buy("ETH-USD");
    const slot = Object.values(f.store.export().eventMarkState.slots).find((s) => s.kind === "AFTER_FILL");
    const before = f.store.export().state.portfolios;
    assert.equal(f.observe(slot.markId, true).benchmarkObservation.consolidated.available, false);
    assert.throws(() => f.store.applyEventMark(f.event("REQUEST_EVENT_MARK", slot.markId, {}, "new-price")), /INVALID_EVENT_MARK_PHASE/);
    assert.deepEqual(f.store.export().state.portfolios, before);
  } finally { f.store.close(); }
});
test("post-T1 books cannot qualify a final B&H value", () => {
  const f = fixture();
  try {
    f.buy("BTC-USD"); f.buy("ETH-USD");
    f.setNow(end - 1); f.store.applyEventMark(f.event("REQUEST_EVENT_MARK"));
    f.setNow(end);
    const books = Object.fromEntries(products.map((p) => [p, { book: f.book(p, end - 1), bodySha256: "d".repeat(64) }]));
    const receipt = f.store.applyEventMark(f.event("OBSERVE_EVENT_MARK", "FINAL", { books }));
    assert.equal(receipt.benchmarkObservation.consolidated.available, false);
    assert.ok(receipt.benchmarkObservation.marks.every((m) => m.reason === "INVALID_TIMELINE"));
  } finally { f.store.close(); }
});
test("late final processing keeps stale proofs unavailable, not zero", () => {
  const f = fixture();
  try {
    f.buy("BTC-USD"); f.buy("ETH-USD");
    f.setNow(end - 1); f.store.applyEventMark(f.event("REQUEST_EVENT_MARK"));
    const books = Object.fromEntries(products.map((p) => [p, { book: f.book(p), bodySha256: "d".repeat(64) }]));
    f.setNow(end + 5_000);
    const receipt = f.store.applyEventMark(f.event("OBSERVE_EVENT_MARK", "FINAL", { books }));
    assert.equal(receipt.benchmarkObservation.consolidated.equity, null);
    assert.ok(receipt.benchmarkObservation.marks.every((m) => m.reason === "STALE_AT_USE"));
  } finally { f.store.close(); }
});
test("after-fill freshness expiring before COMMIT rolls back both observations", () => {
  let expire = false, f;
  f = fixture((phase) => { if (expire && phase === "beforeCommit") f.setNow(start + 5_001); });
  try {
    f.buy("BTC-USD"); f.buy("ETH-USD");
    const slot = Object.values(f.store.export().eventMarkState.slots).find((s) => s.kind === "AFTER_FILL");
    f.store.applyEventMark(f.event("REQUEST_EVENT_MARK", slot.markId));
    const before = f.store.export(), books = Object.fromEntries(products.map((p) => [p, { book: f.book(p), bodySha256: "d".repeat(64) }]));
    expire = true;
    assert.throws(() => f.store.applyEventMark(f.event("OBSERVE_EVENT_MARK", slot.markId, { books })), /MARK_EXPIRED_BEFORE_COMMIT/);
    assert.deepEqual(f.store.export(), before);
  } finally { f.store.close(); }
});
test("lost event-mark response suspends on explicit recovery", () => {
  const f = fixture();
  try {
    f.buy("BTC-USD"); f.buy("ETH-USD");
    const slot = Object.values(f.store.export().eventMarkState.slots).find((s) => s.kind === "AFTER_FILL");
    f.store.applyEventMark(f.event("REQUEST_EVENT_MARK", slot.markId));
    assert.equal(f.store.applyCampaign({ campaignId: manifest.campaignId, commandId: "recover", event: { type: "RECOVER_LOCAL" } }).phase, "suspended");
  } finally { f.store.close(); }
});
test("FINAL uses pre-T1 evidence and never creates a fill or backfills hourly coverage", () => {
  const f = fixture();
  try {
    f.setNow(end - 1);
    f.store.applyEventMark(f.event("REQUEST_EVENT_MARK"));
    const books = Object.fromEntries(products.map((p) => [p, { book: f.book(p), bodySha256: "d".repeat(64) }]));
    f.setNow(end);
    const receipt = f.store.applyEventMark(f.event("OBSERVE_EVENT_MARK", "FINAL", { books }));
    assert.equal(receipt.observation.asOf, end);
    assert.equal(receipt.observation.consolidated.equity, 20_000);
    assert.equal(receipt.benchmarkObservation.consolidated.available, false);
    assert.equal(f.store.export().state.portfolios["BTC-USD"].version, 0);
    f.setNow(Number.NaN);
    assert.deepEqual(f.store.applyEventMark(f.event("OBSERVE_EVENT_MARK", "FINAL", { books })), receipt);
  } finally { f.store.close(); }
});
for (const crashPhase of ["beforeCommit", "afterCommit"]) test(`after-fill process crash ${crashPhase} preserves atomic snapshots`, () => {
  const path = resolve(mkdtempSync(resolve(tmpdir(), "opencode", "p7-event-")), "ledger.sqlite");
  const f = fixture(undefined, true, path);
  f.buy("BTC-USD"); f.buy("ETH-USD");
  const slot = Object.values(f.store.export().eventMarkState.slots).find((s) => s.kind === "AFTER_FILL");
  f.store.applyEventMark(f.event("REQUEST_EVENT_MARK", slot.markId));
  const before = f.store.export(), books = Object.fromEntries(products.map((p) => [p, { book: f.book(p), bodySha256: "d".repeat(64) }]));
  const command = f.event("OBSERVE_EVENT_MARK", slot.markId, { books }); f.store.close();
  const script = `const {P7LocalLedgerStore} = await import(${JSON.stringify(new URL("./p7-prospective-ledger-store.mjs", import.meta.url).href)});
    const store = new P7LocalLedgerStore(${JSON.stringify(path)}, ${JSON.stringify(manifest)}, {now: () => ${start},
      failpoint: (phase) => {if (phase === ${JSON.stringify(crashPhase)}) process.exit(73);}});
    store.applyEventMark(${JSON.stringify(command)}); process.exit(74);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 73, child.stderr);
  const reopened = new P7LocalLedgerStore(path, manifest, { now: () => start });
  try {
    if (crashPhase === "beforeCommit") assert.deepEqual(reopened.export(), before);
    const receipt = reopened.applyEventMark(command);
    assert.deepEqual(reopened.applyEventMark(command), receipt);
    assert.equal(receipt.observation.consolidated.available, true);
    assert.equal(receipt.benchmarkObservation.consolidated.available, true);
    assert.equal(reopened.export().entries.filter((e) => e.command?.commandId === command.commandId).length, 1);
  } finally { reopened.close(); }
});
