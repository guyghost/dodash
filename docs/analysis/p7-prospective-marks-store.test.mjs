import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { P7LocalLedgerStore } from "./p7-prospective-ledger-store.mjs";
const start = Date.UTC(2026, 9, 16), HOUR = 3_600_000;
const manifest = { purpose: "LOCAL_PREPARATION", campaignId: "marks-fixture", manifestSha256: "a".repeat(64),
  startAt: start, endAt: start + 180 * 86_400_000, sourceProfileId: "fixture", clockVerified: true };
const command = (type, scheduledAt = start, books = { "BTC-USD": null, "ETH-USD": null }) => ({
  campaignId: manifest.campaignId, commandId: `${type}-${scheduledAt}`, scheduledAt,
  event: type === "OBSERVE_MARK" ? { type, books } : { type },
});
const temporary = () => {
  const preferred = resolve(tmpdir(), "opencode");
  return resolve(mkdtempSync(resolve(existsSync(preferred) ? preferred : tmpdir(), "p7-marks-")), "ledger.sqlite");
};
const fixture = (path = ":memory:", failpoint) => {
  let now = start - 1;
  const store = new P7LocalLedgerStore(path, manifest, { now: () => now, failpoint });
  return { store, setNow: (value) => { now = value; }, path };
};
const request = (f, scheduledAt = start) => {
  f.setNow(scheduledAt); f.store.applyMark(command("EXPECT_MARK", scheduledAt));
  return f.store.applyMark(command("REQUEST_MARK", scheduledAt));
};
test("marks persist both product projections without a balance or version mutation", () => {
  const f = fixture();
  try {
    const before = f.store.export().state.portfolios; request(f);
    f.setNow(start + 1); const receipt = f.store.applyMark(command("OBSERVE_MARK"));
    assert.equal(receipt.observation.consolidated.equity, 20_000);
    assert.deepEqual(f.store.export().state.portfolios, before);
    assert.equal(f.store.export().entries.at(-1).schemaVersion, 3);
    assert.equal(f.store.markCoverage(start + 3 * HOUR).unobserved, 2);
  } finally { f.store.close(); }
});
test("file reopening and expired redelivery preserve the original mark receipt", () => {
  const f = fixture(temporary()); request(f); const receipt = f.store.applyMark(command("OBSERVE_MARK")); f.store.close();
  const reopened = new P7LocalLedgerStore(f.path, manifest, { now: () => manifest.endAt + 1 });
  try {
    assert.deepEqual(reopened.applyMark(command("OBSERVE_MARK")), receipt);
    assert.equal(reopened.export().entries.length, 4);
    assert.equal(reopened.markCoverage(manifest.endAt).unobserved, 4319);
    assert.throws(() => reopened.applyMark({ ...command("OBSERVE_MARK"), commandId: "replacement" }), /INVALID_MARK_PHASE/);
    assert.throws(() => reopened.apply(command("OBSERVE_MARK")), /COMMAND_ID_CONFLICT/);
  } finally { reopened.close(); }
});
test("requested but lost response remains unobserved and cannot be replaced by a new request", () => {
  const f = fixture(temporary()); request(f); f.store.close();
  const reopened = new P7LocalLedgerStore(f.path, manifest, { now: () => start + HOUR });
  try {
    assert.equal(reopened.markRecovery(start).action, "SUSPEND");
    assert.equal(reopened.markCoverage(start + HOUR).pending, 1);
    assert.throws(() => reopened.applyMark({ ...command("REQUEST_MARK"), commandId: "refetch" }), /MARK_WINDOW_EXPIRED|INVALID_MARK_PHASE/);
    assert.throws(() => reopened.applyMark(command("OBSERVE_MARK")), /MARK_WINDOW_EXPIRED/);
  } finally { reopened.close(); }
});
test("rollback before COMMIT keeps the requested checkpoint and no partial mark", () => {
  let fail = false;
  const f = fixture(":memory:", (phase) => { if (fail && phase === "beforeCommit") throw new Error("synthetic crash"); });
  try {
    request(f); const before = f.store.export(); fail = true;
    assert.throws(() => f.store.applyMark(command("OBSERVE_MARK")), /synthetic crash/);
    assert.deepEqual(f.store.export(), before);
    fail = false; f.store.applyMark(command("OBSERVE_MARK"));
    assert.equal(f.store.export().entries.length, 4);
  } finally { f.store.close(); }
});
for (const crashPhase of ["beforeCommit", "afterCommit"]) test(`mark observation survives process exit ${crashPhase}`, () => {
  const f = fixture(temporary()); request(f); const before = f.store.export(); f.store.close();
  const script = `const { P7LocalLedgerStore } = await import(${JSON.stringify(new URL("./p7-prospective-ledger-store.mjs", import.meta.url).href)});
    const store = new P7LocalLedgerStore(${JSON.stringify(f.path)}, ${JSON.stringify(manifest)}, {
      now: () => ${start}, failpoint: (phase) => { if (phase === ${JSON.stringify(crashPhase)}) process.exit(73); }
    }); store.applyMark(${JSON.stringify(command("OBSERVE_MARK"))}); process.exit(74);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 73, child.stderr);
  const reopened = new P7LocalLedgerStore(f.path, manifest, { now: () => start });
  try {
    if (crashPhase === "beforeCommit") assert.deepEqual(reopened.export(), before);
    reopened.applyMark(command("OBSERVE_MARK"));
    assert.equal(reopened.export().entries.length, 4);
    assert.equal(reopened.export().state.portfolios["BTC-USD"].version, 0);
  } finally { reopened.close(); }
});

const buy = (f) => {
  f.setNow(start + 1);
  for (const event of [{ type: "EXPECT" }, { type: "ADMIT", evaluatedAt: start + 1, windowSha256: "b".repeat(64) },
    { type: "INTENT", side: "BUY", quantity: 2, portfolioVersion: 0 }, { type: "REQUEST_QUOTE" },
    { type: "OBSERVE_QUOTE", bodySha256: "c".repeat(64), book: { productId: "BTC-USD", sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "1",
      requestedAt: start + 1, receivedAt: start + 1, sourceObservedAt: start + 1, bids: [{ price: 99, quantity: 100 }], asks: [{ price: 101, quantity: 100 }] } }])
    f.store.apply({ campaignId: manifest.campaignId, commandId: event.type, productId: "BTC-USD", candleClosedAt: start, event });
  return f.store.commitPricing({ campaignId: manifest.campaignId, commandId: "priced-buy", productId: "BTC-USD", candleClosedAt: start });
};
const books = (override = {}) => ({ "ETH-USD": null, "BTC-USD": { bodySha256: "d".repeat(64), book: {
  productId: "BTC-USD", sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "2",
  requestedAt: start, receivedAt: start + 2, sourceObservedAt: start + 2,
  bids: [{ price: 99, quantity: 100 }], asks: [{ price: 101, quantity: 100 }], ...override,
} } });
test("response uses the portfolio committed after the mark request, not the former flat balance", () => {
  const f = fixture();
  try {
    request(f); const fill = buy(f); f.setNow(start + 2);
    const mark = f.store.applyMark(command("OBSERVE_MARK", start, books()));
    assert.equal(mark.observation.portfolios["BTC-USD"].version, 1);
    assert.equal(mark.observation.portfolios["BTC-USD"].positionQuantity, 2);
    assert.equal(mark.observation.consolidated.equity, fill.portfolio.cash + 2 * 99 * 0.9998 * 0.994 + 10_000);
    assert.deepEqual(f.store.export().state.portfolios["BTC-USD"], fill.portfolio);
  } finally { f.store.close(); }
});
for (const [override, at, reason] of [
  [{}, start + 5_003, "STALE_AT_USE"],
  [{ bids: [{ price: 99, quantity: 1 }] }, start + 2, "INSUFFICIENT_DEPTH"],
  [{ requestedAt: start + 1 }, start + 2, "REQUEST_CHECKPOINT_MISMATCH"],
  [{ sequence: "0" }, start + 2, "SEQUENCE_INVALID"],
]) test(`open position mark retains ${reason}, not an equity of zero`, () => {
  const f = fixture();
  try {
    request(f); buy(f); f.setNow(at);
    const receipt = f.store.applyMark(command("OBSERVE_MARK", start, books(override)));
    assert.equal(receipt.observation.consolidated.equity, null);
    assert.equal(receipt.observation.marks[0].reason, reason);
    assert.equal(f.store.markCoverage(start + HOUR).unavailable, 1);
    assert.equal(f.store.markCoverage(start + HOUR).unobserved, 0);
  } finally { f.store.close(); }
});
test("expiry after insertion rolls back an available open-position mark", () => {
  let expire = false, f;
  f = fixture(":memory:", (phase) => { if (expire && phase === "beforeCommit") f.setNow(start + 5_003); });
  try {
    request(f); buy(f); f.setNow(start + 2); const before = f.store.export(); expire = true;
    assert.throws(() => f.store.applyMark(command("OBSERVE_MARK", start, books())), /MARK_EXPIRED_BEFORE_COMMIT/);
    assert.deepEqual(f.store.export(), before);
    expire = false; f.store.applyMark(command("OBSERVE_MARK", start, books()));
    assert.equal(f.store.markCoverage(start + HOUR).unavailable, 1);
  } finally { f.store.close(); }
});
test("replay rejects a forged mark even with a recomputed event hash", () => {
  const f = fixture(temporary()); request(f); f.store.applyMark(command("OBSERVE_MARK"));
  const raw = new DatabaseSync(f.path);
  try {
    const entry = JSON.parse(raw.prepare("SELECT body FROM p7_ledger WHERE sequence=4").get().body);
    entry.receipt.observation.consolidated.equity = 1;
    const canonical = (v) => v !== null && typeof v === "object" ? Array.isArray(v) ? `[${v.map(canonical).join(",")}]` :
      `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
    const body = canonical(entry);
    raw.exec("DROP TRIGGER p7_ledger_no_update");
    raw.prepare("UPDATE p7_ledger SET body=?, hash=? WHERE sequence=4").run(body, createHash("sha256").update(body).digest("hex"));
    assert.throws(() => f.store.export(), /LEDGER_CORRUPT/);
  } finally { raw.close(); f.store.close(); }
});
test("two connections see one observation and reject a changed proof under the same ID", () => {
  const f = fixture(temporary()); request(f);
  const second = new P7LocalLedgerStore(f.path, manifest, { now: () => start });
  try {
    const receipt = f.store.applyMark(command("OBSERVE_MARK"));
    assert.deepEqual(second.applyMark(command("OBSERVE_MARK")), receipt);
    assert.throws(() => second.applyMark(command("OBSERVE_MARK", start, books())), /COMMAND_ID_CONFLICT/);
    assert.equal(second.export().entries.length, 4);
  } finally { second.close(); f.store.close(); }
});
test("clock regression after insertion rolls back even a cash-only mark", () => {
  let regress = false, f;
  f = fixture(":memory:", (phase) => { if (regress && phase === "beforeCommit") f.setNow(start - 1); });
  try {
    request(f); const before = f.store.export(); regress = true;
    assert.throws(() => f.store.applyMark(command("OBSERVE_MARK")), /COMMIT_CLOCK_INVALID/);
    assert.deepEqual(f.store.export(), before);
  } finally { f.store.close(); }
});
