import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { P7LocalLedgerStore } from "./p7-prospective-ledger-store.mjs";

const close = Date.UTC(2026, 9, 16);
const manifest = { purpose: "LOCAL_PREPARATION", campaignId: "fixture-p7", manifestSha256: "a".repeat(64),
  startAt: close, endAt: close + 180 * 86400000, sourceProfileId: "fixture-spot", clockVerified: true };
const preferredTemp = resolve(tmpdir(), "opencode");
const temporary = () => resolve(mkdtempSync(resolve(existsSync(preferredTemp) ? preferredTemp : tmpdir(), "p7-ledger-")), "ledger.sqlite");
const fixture = (path = temporary(), failpoint) => {
  let now = close - 1;
  const store = new P7LocalLedgerStore(path, manifest, { now: () => now, failpoint });
  const apply = (event, commandId = event.type, productId = "BTC-USD") => {
    now = close + 60_000;
    return store.apply({ campaignId: manifest.campaignId, commandId, productId, candleClosedAt: close, event });
  };
  return { store, apply, path, setNow: (at) => { now = at; } };
};
const prepare = (f) => {
  f.apply({ type: "EXPECT" });
  f.apply({ type: "ADMIT", evaluatedAt: close + 1, windowSha256: "b".repeat(64) });
  f.apply({ type: "INTENT", side: "BUY", quantity: 1, portfolioVersion: 0 });
  f.apply({ type: "REQUEST_QUOTE" });
  f.apply({ type: "OBSERVE_QUOTE", bodySha256: "c".repeat(64), book: {
    productId: "BTC-USD", sourceProfileId: "fixture-spot", cacheStatus: "UNCACHED", sequence: "100",
    requestedAt: close + 60_000, receivedAt: close + 60_000, sourceObservedAt: close + 60_000,
    bids: [{ price: 99, quantity: 2 }], asks: [{ price: 101, quantity: 2 }],
  } });
};
const fill = { type: "TERMINATE", outcome: { kind: "SIMULATED_FILL", price: 101, fee: 0.606 } };

test("reopening and redelivery return the original receipt with one debit", () => {
  const f = fixture(); prepare(f);
  const first = f.apply(fill); const count = f.store.export().entries.length; f.store.close();
  const reopened = fixture(f.path);
  try {
    assert.deepEqual(reopened.apply(fill), first);
    assert.equal(reopened.store.export().entries.length, count);
    assert.deepEqual(reopened.store.export().state.portfolios["BTC-USD"], { cash: 9898.394, positionQuantity: 1, version: 1 });
    assert.throws(() => reopened.apply({ ...fill, outcome: { ...fill.outcome, price: 102 } }), /COMMAND_ID_CONFLICT/);
    assert.throws(() => reopened.apply(fill, "second-fill"), /INVALID_PHASE/);
  } finally { reopened.store.close(); }
});

test("failure before COMMIT rolls back both outcome and portfolio, then resumes the persisted quote", () => {
  let fail = false;
  const f = fixture(undefined, (phase) => { if (fail && phase === "beforeCommit") throw new Error("synthetic crash"); });
  try {
    prepare(f); const before = f.store.export(); fail = true;
    assert.throws(() => f.apply(fill), /synthetic crash/);
    assert.deepEqual(f.store.export(), before);
    fail = false; f.apply(fill);
    assert.equal(f.store.export().state.portfolios["BTC-USD"].positionQuantity, 1);
  } finally { f.store.close(); }
});

test("lost acknowledgement after COMMIT cannot debit again", () => {
  let fail = false;
  const f = fixture(undefined, (phase) => { if (fail && phase === "afterCommit") throw new Error("lost acknowledgement"); });
  try {
    prepare(f); fail = true; assert.throws(() => f.apply(fill), /lost acknowledgement/);
    fail = false; f.apply(fill);
    assert.equal(f.store.export().state.portfolios["BTC-USD"].cash, 9898.394);
    assert.equal(f.store.export().entries.filter((e) => e.command?.event.type === "TERMINATE").length, 1);
  } finally { f.store.close(); }
});

test("a missing quote response remains suspended after real file reopening", () => {
  const f = fixture();
  for (const event of [{ type: "EXPECT" }, { type: "ADMIT", evaluatedAt: close + 1, windowSha256: "b".repeat(64) }, { type: "INTENT", side: "BUY", quantity: 1, portfolioVersion: 0 }, { type: "REQUEST_QUOTE" }]) f.apply(event);
  f.store.close(); const reopened = fixture(f.path);
  try { assert.equal(reopened.store.recovery("BTC-USD", close, close + 60_100).action, "SUSPEND"); }
  finally { reopened.store.close(); }
});

test("SQL refuses mutation and export detects a deliberately corrupted hash", () => {
  const f = fixture(); f.apply({ type: "EXPECT" }); const raw = new DatabaseSync(f.path);
  try {
    assert.throws(() => raw.exec("DELETE FROM p7_ledger"), /append-only/);
    assert.throws(() => raw.exec("UPDATE p7_ledger SET hash = 'broken'"), /append-only/);
    raw.exec("DROP TRIGGER p7_ledger_no_update"); raw.exec("UPDATE p7_ledger SET hash = 'broken' WHERE sequence = 2");
    assert.throws(() => f.store.export(), /LEDGER_CORRUPT/);
    assert.throws(() => f.apply({ type: "ADMIT", evaluatedAt: close + 1, windowSha256: "b".repeat(64) }), /LEDGER_CORRUPT/);
  } finally { raw.close(); f.store.close(); }
});

for (const crashPhase of ["beforeCommit", "afterCommit"]) test(`real child-process exit ${crashPhase} preserves atomic recovery`, () => {
  const f = fixture(); prepare(f); const before = f.store.export(); f.store.close();
  const command = { campaignId: manifest.campaignId, commandId: "TERMINATE", productId: "BTC-USD", candleClosedAt: close, event: fill };
  const script = `const { P7LocalLedgerStore } = await import(${JSON.stringify(new URL("./p7-prospective-ledger-store.mjs", import.meta.url).href)});
    const store = new P7LocalLedgerStore(${JSON.stringify(f.path)}, ${JSON.stringify(manifest)}, {
      now: () => ${close + 60_000}, failpoint: (phase) => { if (phase === ${JSON.stringify(crashPhase)}) process.exit(73); }
    }); store.apply(${JSON.stringify(command)}); process.exit(74);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 73, child.stderr);
  const reopened = fixture(f.path);
  try {
    const journal = reopened.store.export();
    if (crashPhase === "beforeCommit") assert.deepEqual(journal, before);
    else assert.equal(journal.state.portfolios["BTC-USD"].cash, 9898.394);
    reopened.apply(fill);
    assert.equal(reopened.store.export().state.portfolios["BTC-USD"].cash, 9898.394);
    assert.equal(reopened.store.export().entries.filter((e) => e.command?.event.type === "TERMINATE").length, 1);
  } finally { reopened.store.close(); }
});

test("idempotency ignores JSON key order and remains valid after campaign expiry", () => {
  const f = fixture(); prepare(f); const receipt = f.apply(fill);
  try {
    f.setNow(manifest.endAt + 1);
    assert.deepEqual(f.store.apply({ event: fill, candleClosedAt: close, productId: "BTC-USD", commandId: "TERMINATE", campaignId: manifest.campaignId }), receipt);
    assert.equal(f.store.export().state.portfolios["BTC-USD"].version, 1);
  } finally { f.store.close(); }
});

test("two open connections see the same terminal fact, not independent cached balances", () => {
  const f = fixture(); prepare(f); const second = fixture(f.path);
  try {
    const receipt = f.apply(fill); assert.deepEqual(second.apply(fill), receipt);
    assert.equal(second.store.export().state.portfolios["BTC-USD"].positionQuantity, 1);
    assert.throws(() => second.apply(fill, "different-id"), /INVALID_PHASE/);
  } finally { f.store.close(); second.store.close(); }
});

test("unrelated SQLite files are rejected without altering their schema", () => {
  const path = temporary(), raw = new DatabaseSync(path);
  try {
    raw.exec("CREATE TABLE user_work(value TEXT)"); raw.exec("INSERT INTO user_work VALUES ('preserve')");
    assert.throws(() => fixture(path), /FOREIGN_DATABASE/);
    assert.equal(raw.prepare("SELECT value FROM user_work").get().value, "preserve");
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='p7_ledger'").get(), undefined);
  } finally { raw.close(); }
});

test("malformed commands and non-JSON values cannot append a fact", () => {
  const f = fixture();
  try {
    const before = f.store.export();
    for (const invalid of [null, 42, [], {}]) assert.throws(() => f.store.apply(invalid), /INVALID_COMMAND/);
    assert.throws(() => f.store.apply({ commandId: "bad", quantity: NaN }), /INVALID_JSON_VALUE/);
    let invoked = false;
    assert.throws(() => f.store.apply({ get commandId() { invoked = true; return "getter"; } }), /INVALID_JSON_ACCESSOR/);
    assert.equal(invoked, false);
    assert.deepEqual(f.store.export(), before);
  } finally { f.store.close(); }
});
