import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { P7LocalLedgerStore } from "./p7-prospective-ledger-store.mjs";
import { planP7LocalTerminal } from "./p7-prospective-pricing.mjs";
const start = Date.UTC(2026, 9, 16), at = start + 1_000;
const manifest = { purpose: "LOCAL_PREPARATION", campaignId: "atomic-pricing", manifestSha256: "a".repeat(64),
  startAt: start, endAt: start + 180 * 86_400_000, sourceProfileId: "fixture", clockVerified: true };
const request = { campaignId: manifest.campaignId, commandId: "priced-terminal", productId: "BTC-USD", candleClosedAt: start };
const temporary = () => {
  const preferred = resolve(tmpdir(), "opencode");
  return resolve(mkdtempSync(resolve(existsSync(preferred) ? preferred : tmpdir(), "p7-atomic-")), "ledger.sqlite");
};
const fixture = ({ path = ":memory:", quantity = 2, failpoint, quote = {}, stopAtRequest = false, clock } = {}) => {
  let now = start - 1;
  const store = new P7LocalLedgerStore(path, manifest, { now: () => clock ? clock(now) : now, failpoint });
  now = at;
  const events = [{ type: "EXPECT" }, { type: "ADMIT", evaluatedAt: start + 1, windowSha256: "b".repeat(64) },
    { type: "INTENT", side: "BUY", quantity, portfolioVersion: 0 }, { type: "REQUEST_QUOTE" }];
  if (!stopAtRequest) events.push({ type: "OBSERVE_QUOTE", bodySha256: "c".repeat(64), book: {
    productId: "BTC-USD", sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "1",
    requestedAt: at, receivedAt: at, sourceObservedAt: at,
    bids: [{ price: 99, quantity: 100 }], asks: [{ price: 101, quantity: 1 }, { price: 102, quantity: 99 }], ...quote,
  } });
  for (const event of events) store.apply({ ...request, commandId: event.type, event });
  return { store, setNow: (value) => { now = value; }, path };
};
test("commit prices inside transaction and redelivery returns one durable receipt", () => {
  const f = fixture();
  try {
    const receipt = f.store.commitPricing(request);
    assert.equal(receipt.portfolio.cash, 10_000 - 101.5 * 1.0002 * 2 * 1.006);
    const event = f.store.export().entries.at(-1);
    assert.equal(event.schemaVersion, 2);
    assert.deepEqual(event.pricingRequest, request);
    assert.equal(event.command.event.outcome.price, 101.5 * 1.0002);
    f.setNow(manifest.endAt + 1);
    assert.deepEqual(f.store.commitPricing({ ...request }), receipt);
    assert.equal(f.store.export().entries.length, 7);
    assert.throws(() => f.store.commitPricing({ ...request, productId: "ETH-USD" }), /COMMAND_ID_CONFLICT/);
    assert.throws(() => f.store.commitPricing({ ...request, commandId: "other" }), /INVALID_PHASE/);
  } finally { f.store.close(); }
});
test("a fresh external plan cannot rescue a stale quote at commit", () => {
  const f = fixture();
  try {
    assert.equal(planP7LocalTerminal(f.store, "BTC-USD", start, at).outcome.kind, "SIMULATED_FILL");
    f.setNow(at + 5_001); f.store.commitPricing(request);
    assert.deepEqual(f.store.export().entries.at(-1).command.event.outcome, { kind: "QUOTE_REJECTED", reason: "STALE_AT_USE" });
    assert.equal(f.store.export().state.portfolios["BTC-USD"].cash, 10_000);
  } finally { f.store.close(); }
});
test("expiry between insertion and COMMIT rolls back everything", () => {
  let expire = false, f;
  f = fixture({ failpoint: (phase) => { if (expire && phase === "beforeCommit") f.setNow(at + 5_001); } });
  try {
    const before = f.store.export(); expire = true;
    assert.throws(() => f.store.commitPricing(request), /PRICING_EXPIRED_BEFORE_COMMIT/);
    assert.deepEqual(f.store.export(), before);
    expire = false; f.store.commitPricing(request);
    assert.equal(f.store.export().entries.at(-1).command.event.outcome.kind, "QUOTE_REJECTED");
  } finally { f.store.close(); }
});
test("request is closed and cannot carry caller prices, outcomes or timestamps", () => {
  const f = fixture();
  try {
    const before = f.store.export();
    for (const extra of [{ price: 1 }, { outcome: { kind: "HOLD" } }, { asOf: at }, { quote: null }])
      assert.throws(() => f.store.commitPricing({ ...request, ...extra }), /INVALID_PRICING_REQUEST/);
    assert.throws(() => f.store.commitPricing({ ...request, campaignId: "wrong" }), /INVALID_PRICING_REQUEST/);
    assert.deepEqual(f.store.export(), before);
  } finally { f.store.close(); }
});
test("missing quote response stays suspended without a fact or refetch", () => {
  const f = fixture({ stopAtRequest: true });
  try {
    const before = f.store.export();
    assert.throws(() => f.store.commitPricing(request), /QUOTE_RESPONSE_UNOBSERVED/);
    assert.deepEqual(f.store.export(), before);
  } finally { f.store.close(); }
});
test("reopening preserves V2 receipt and prevents collisions with the V1 fixture API", () => {
  const f = fixture({ path: temporary() });
  const receipt = f.store.commitPricing(request), entry = f.store.export().entries.at(-1); f.store.close();
  const reopened = new P7LocalLedgerStore(f.path, manifest, { now: () => manifest.endAt + 1 });
  try {
    assert.deepEqual(reopened.commitPricing(request), receipt);
    assert.throws(() => reopened.apply(entry.command), /COMMAND_ID_CONFLICT/);
    assert.throws(() => reopened.commitPricing({ ...request, commandId: "EXPECT" }), /COMMAND_ID_CONFLICT/);
  } finally { reopened.close(); }
});
test("replay rejects tampered derived pricing even if hashes are recalculated", () => {
  const f = fixture({ path: temporary() }); f.store.commitPricing(request);
  const raw = new DatabaseSync(f.path);
  try {
    raw.exec("DROP TRIGGER p7_ledger_no_update");
    const row = raw.prepare("SELECT body FROM p7_ledger WHERE sequence=7").get();
    // Replace the exact canonical number; recomputing hash removes the superficial hash failure.
    const entry = JSON.parse(row.body); entry.command.event.outcome.price = 1;
    const canonical = (v) => v !== null && typeof v === "object" ? Array.isArray(v) ? `[${v.map(canonical).join(",")}]` :
      `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
    const body = canonical(entry);
    raw.prepare("UPDATE p7_ledger SET body=?, hash=? WHERE sequence=7").run(body, createHash("sha256").update(body).digest("hex"));
    assert.throws(() => f.store.export(), /LEDGER_CORRUPT/);
  } finally { raw.close(); f.store.close(); }
});
test("pricing clock is sampled after a real SQLite lock wait", async () => {
  const shared = new SharedArrayBuffer(4), phase = new Int32Array(shared);
  const f = fixture({ path: temporary(), clock: (fallback) => Atomics.load(phase, 0) === 2 ? at + 5_001 : fallback });
  const worker = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const phase = new Int32Array(workerData.shared), db = new DatabaseSync(workerData.path);
    db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
    Atomics.wait(phase, 0, 0, 5000);
    setTimeout(() => { Atomics.store(phase, 0, 2); db.exec('COMMIT'); db.close(); }, 50);
  `, { eval: true, workerData: { shared, path: f.path } });
  try {
    const [message] = await once(worker, "message"); assert.equal(message, "locked");
    Atomics.store(phase, 0, 1); Atomics.notify(phase, 0);
    f.store.commitPricing(request);
    assert.equal(f.store.export().entries.at(-1).recordedAt, at + 5_001);
    assert.deepEqual(f.store.export().entries.at(-1).command.event.outcome, { kind: "QUOTE_REJECTED", reason: "STALE_AT_USE" });
  } finally { await worker.terminate(); f.store.close(); }
});
for (const [quantity, quote, kind, reason] of [
  [100, {}, "BROKER_REJECTED", "INSUFFICIENT_CASH"], [101, {}, "QUOTE_REJECTED", "INSUFFICIENT_DEPTH"],
  [2, { receivedAt: at + 1 }, "QUOTE_REJECTED", "INVALID_TIMELINE"],
]) test(`atomic resolution retains ${reason} without cash mutation`, () => {
  const f = fixture({ quantity, quote });
  try {
    f.store.commitPricing(request);
    assert.deepEqual(f.store.export().entries.at(-1).command.event.outcome, { kind, reason });
    assert.equal(f.store.export().state.portfolios["BTC-USD"].cash, 10_000);
  } finally { f.store.close(); }
});
for (const crashPhase of ["beforeCommit", "afterCommit"]) test(`priced resolution survives process exit ${crashPhase}`, () => {
  const f = fixture({ path: temporary() }); const before = f.store.export(); f.store.close();
  const script = `const { P7LocalLedgerStore } = await import(${JSON.stringify(new URL("./p7-prospective-ledger-store.mjs", import.meta.url).href)});
    const store = new P7LocalLedgerStore(${JSON.stringify(f.path)}, ${JSON.stringify(manifest)}, {
      now: () => ${at}, failpoint: (phase) => { if (phase === ${JSON.stringify(crashPhase)}) process.exit(73); }
    }); store.commitPricing(${JSON.stringify(request)}); process.exit(74);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 73, child.stderr);
  const reopened = new P7LocalLedgerStore(f.path, manifest, { now: () => at });
  try {
    if (crashPhase === "beforeCommit") assert.deepEqual(reopened.export(), before);
    reopened.commitPricing(request);
    assert.equal(reopened.export().entries.length, 7);
    assert.equal(reopened.export().state.portfolios["BTC-USD"].positionQuantity, 2);
  } finally { reopened.close(); }
});
test("clock regression after insertion rolls back rather than stamping a future fill", () => {
  let regress = false, f;
  f = fixture({ failpoint: (phase) => { if (regress && phase === "beforeCommit") f.setNow(at - 1); } });
  try {
    const before = f.store.export(); regress = true;
    assert.throws(() => f.store.commitPricing(request), /COMMIT_CLOCK_INVALID/);
    assert.deepEqual(f.store.export(), before);
  } finally { f.store.close(); }
});
test("two connections cannot resolve the same priced slot twice", () => {
  const f = fixture({ path: temporary() });
  const second = new P7LocalLedgerStore(f.path, manifest, { now: () => at });
  try {
    assert.deepEqual(second.commitPricing(request), f.store.commitPricing(request));
    assert.throws(() => second.commitPricing({ ...request, commandId: "second-resolution" }), /INVALID_PHASE/);
    assert.equal(second.export().entries.length, 7);
  } finally { second.close(); f.store.close(); }
});
