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
const manifest = { purpose: "LOCAL_PREPARATION", campaignId: "campaign-fixture", manifestSha256: "a".repeat(64),
  startAt: start, endAt: start + 180 * 86_400_000, sourceProfileId: "fixture", clockVerified: true };
const request = { campaignId: manifest.campaignId, commandId: "safe-price", productId: "BTC-USD", candleClosedAt: start };
const campaign = (type, commandId = type) => ({ campaignId: manifest.campaignId, commandId, event: { type } });
const temporary = () => {
  const preferred = resolve(tmpdir(), "opencode");
  return resolve(mkdtempSync(resolve(existsSync(preferred) ? preferred : tmpdir(), "p7-campaign-")), "ledger.sqlite");
};
const fixture = ({ path = ":memory:", failpoint, bind = true } = {}) => {
  let now = start - 1;
  const store = new P7LocalLedgerStore(path, manifest, { now: () => now, failpoint });
  now = start;
  if (bind) store.applyCampaign(campaign("BEGIN_LOCAL_SIMULATION"));
  const quote = (close = start, at = close + 1, suffix = "", productId = "BTC-USD", quantity = 2) => {
    now = at;
    for (const event of [{ type: "EXPECT" }, { type: "ADMIT", evaluatedAt: at, windowSha256: "b".repeat(64) },
      { type: "INTENT", side: "BUY", quantity, portfolioVersion: 0 }, { type: "REQUEST_QUOTE" },
      { type: "OBSERVE_QUOTE", bodySha256: "c".repeat(64), book: { productId, sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "1",
        requestedAt: at, receivedAt: at, sourceObservedAt: at, bids: [{ price: 99, quantity: 100 }], asks: [{ price: 101, quantity: 100 }] } }])
      store.apply({ ...request, productId, commandId: event.type + suffix, candleClosedAt: close, event });
  };
  return { store, quote, path, setNow: (value) => { now = value; } };
};
test("unbound guarded pricing returns a durable gate refusal, never a fill", () => {
  const f = fixture({ bind: false });
  try {
    const receipt = f.store.commitCampaignPricing(request);
    assert.equal(receipt.allowed, false);
    assert.equal(receipt.campaign.phase, "registered");
    assert.equal(f.store.export().state.portfolios["BTC-USD"].cash, 10_000);
    assert.deepEqual(f.store.commitCampaignPricing(request), receipt);
  } finally { f.store.close(); }
});
test("bound safe pricing commits through V5 and disables V1/V2 fill bypasses", () => {
  const f = fixture();
  try {
    f.quote();
    assert.throws(() => f.store.commitPricing(request), /USE_CAMPAIGN_PRICING/);
    assert.throws(() => f.store.apply({ ...request, commandId: "raw-fill", event: { type: "TERMINATE", outcome: { kind: "SIMULATED_FILL", price: 1, fee: 0.012 } } }), /LEGACY_FILL_DISABLED/);
    const receipt = f.store.commitCampaignPricing(request);
    assert.equal(receipt.allowed, true);
    assert.equal(receipt.receipt.portfolio.positionQuantity, 2);
    assert.equal(f.store.export().entries.at(-1).schemaVersion, 5);
  } finally { f.store.close(); }
});
test("a gap over 2h is persisted as suspension and survives reopening", () => {
  const f = fixture({ path: temporary() }); f.quote(); f.setNow(start + 2 * HOUR + 1);
  const receipt = f.store.commitCampaignPricing(request); f.store.close();
  const reopened = new P7LocalLedgerStore(f.path, manifest, { now: () => start + 2 * HOUR + 2 });
  try {
    assert.equal(receipt.allowed, false);
    assert.equal(receipt.campaign.phase, "suspended");
    assert.equal(reopened.export().state.portfolios["BTC-USD"].positionQuantity, 0);
    assert.deepEqual(reopened.commitCampaignPricing(request), receipt);
    assert.equal(reopened.export().campaignState.phase, "suspended");
    assert.throws(() => reopened.apply({ ...request, commandId: "new-intent", event: { type: "INTENT", side: "BUY", quantity: 1, portfolioVersion: 0 } }), /CAMPAIGN_SAFETY_BLOCKED/);
  } finally { reopened.close(); }
});
test("RECOVER_LOCAL treats a missing durable response as suspension without refetch", () => {
  const f = fixture();
  try {
    for (const type of ["EXPECT_MARK", "REQUEST_MARK"]) f.store.applyMark({ campaignId: manifest.campaignId, commandId: type, scheduledAt: start, event: { type } });
    const receipt = f.store.applyCampaign(campaign("RECOVER_LOCAL"));
    assert.equal(receipt.phase, "suspended");
    assert.ok(receipt.reasons.includes("RESPONSE_UNOBSERVED_AT_RECOVERY"));
    assert.equal(f.store.commitCampaignPricing(request).allowed, false);
  } finally { f.store.close(); }
});
test("diagnostic marks remain possible after a sticky operator stop", () => {
  const f = fixture();
  try {
    f.store.applyCampaign(campaign("STOP_LOCAL"));
    for (const type of ["EXPECT_MARK", "REQUEST_MARK", "OBSERVE_MARK"]) f.store.applyMark({ campaignId: manifest.campaignId, commandId: type, scheduledAt: start,
      event: type === "OBSERVE_MARK" ? { type, books: { "BTC-USD": null, "ETH-USD": null } } : { type } });
    assert.equal(f.store.export().campaignState.phase, "stopped");
    assert.equal(f.store.commitCampaignPricing(request).allowed, false);
    assert.equal(f.store.markCoverage(start + HOUR).available, 1);
  } finally { f.store.close(); }
});
test("gate crossing after insertion rolls back a fill then persists refusal on retry", () => {
  let expire = false, f;
  // Last fresh source time at the 2h boundary: pricing still has a 5s budget.
  f = fixture({ failpoint: (phase) => { if (expire && phase === "beforeCommit") f.setNow(start + 2 * HOUR + 1); } });
  try {
    f.quote(start, start + 2 * HOUR); const before = f.store.export(); expire = true;
    assert.throws(() => f.store.commitCampaignPricing(request), /CAMPAIGN_BLOCKED_BEFORE_COMMIT/);
    assert.deepEqual(f.store.export(), before);
    expire = false; const receipt = f.store.commitCampaignPricing(request);
    assert.equal(receipt.allowed, false);
    assert.equal(receipt.campaign.phase, "suspended");
  } finally { f.store.close(); }
});
for (const crashPhase of ["beforeCommit", "afterCommit"]) test(`guarded resolution survives process exit ${crashPhase}`, () => {
  const f = fixture({ path: temporary() }); f.quote(); const before = f.store.export(); f.store.close();
  const script = `const { P7LocalLedgerStore } = await import(${JSON.stringify(new URL("./p7-prospective-ledger-store.mjs", import.meta.url).href)});
    const store = new P7LocalLedgerStore(${JSON.stringify(f.path)}, ${JSON.stringify(manifest)}, {
      now: () => ${start + 1}, failpoint: (phase) => { if (phase === ${JSON.stringify(crashPhase)}) process.exit(73); }
    }); store.commitCampaignPricing(${JSON.stringify(request)}); process.exit(74);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 73, child.stderr);
  const reopened = new P7LocalLedgerStore(f.path, manifest, { now: () => start + 1 });
  try {
    if (crashPhase === "beforeCommit") assert.deepEqual(reopened.export(), before);
    const receipt = reopened.commitCampaignPricing(request);
    assert.equal(receipt.receipt.portfolio.positionQuantity, 2);
    assert.equal(reopened.export().entries.length, 8);
  } finally { reopened.close(); }
});
test("a persisted >50% mark stops guarded fills and remains stopped after a rebound", () => {
  const f = fixture();
  try {
    for (const productId of ["BTC-USD", "ETH-USD"]) {
      f.quote(start, start + 1, productId, productId, 98);
      f.store.commitCampaignPricing({ ...request, productId, commandId: `buy-${productId}` });
    }
    const observe = (scheduledAt, at, bid) => {
      f.setNow(at);
      for (const type of ["EXPECT_MARK", "REQUEST_MARK", "OBSERVE_MARK"]) f.store.applyMark({ campaignId: manifest.campaignId, commandId: `${type}-${scheduledAt}`,
        scheduledAt, event: type === "OBSERVE_MARK" ? { type, books: Object.fromEntries(["BTC-USD", "ETH-USD"].map((productId) => [productId, {
          bodySha256: "d".repeat(64), book: { productId, sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: String(scheduledAt),
            requestedAt: at, receivedAt: at, sourceObservedAt: at, bids: [{ price: bid, quantity: 100 }], asks: [{ price: bid + 1, quantity: 100 }] },
        }])) } : { type } });
    };
    observe(start, start + 1_000, 1);
    assert.equal(f.store.export().campaignState.phase, "stopped");
    assert.ok(f.store.export().campaignState.maxDrawdown > 0.5);
    observe(start + HOUR, start + HOUR, 200);
    const receipt = f.store.commitCampaignPricing({ ...request, commandId: "post-rebound" });
    assert.equal(receipt.allowed, false);
    assert.equal(receipt.campaign.phase, "stopped");
    assert.ok(receipt.campaign.reasons.includes("SAMPLED_DRAWDOWN_EXCEEDED"));
  } finally { f.store.close(); }
});
test("recovery detects an execution request without a durable book", () => {
  const f = fixture();
  try {
    f.quote();
    for (const event of [{ type: "EXPECT" }, { type: "ADMIT", evaluatedAt: start + 1, windowSha256: "b".repeat(64) },
      { type: "INTENT", side: "BUY", quantity: 1, portfolioVersion: 0 }, { type: "REQUEST_QUOTE" }])
      f.store.apply({ ...request, productId: "ETH-USD", commandId: `eth-${event.type}`, event });
    const receipt = f.store.applyCampaign(campaign("RECOVER_LOCAL"));
    assert.equal(receipt.phase, "suspended");
    assert.equal(f.store.commitCampaignPricing(request).allowed, false);
    assert.equal(f.store.export().state.portfolios["BTC-USD"].positionQuantity, 0);
  } finally { f.store.close(); }
});
test("replay rejects a forged allowed gate receipt despite a recomputed hash", () => {
  const f = fixture({ path: temporary() }); f.setNow(start + 2 * HOUR + 1); f.store.commitCampaignPricing(request);
  const raw = new DatabaseSync(f.path);
  try {
    const row = raw.prepare("SELECT sequence, body FROM p7_ledger ORDER BY sequence DESC LIMIT 1").get();
    const entry = JSON.parse(row.body); entry.receipt.allowed = true;
    const canonical = (v) => v !== null && typeof v === "object" ? Array.isArray(v) ? `[${v.map(canonical).join(",")}]` :
      `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
    const body = canonical(entry);
    raw.exec("DROP TRIGGER p7_ledger_no_update");
    raw.prepare("UPDATE p7_ledger SET body=?, hash=? WHERE sequence=?").run(body, createHash("sha256").update(body).digest("hex"), row.sequence);
    assert.throws(() => f.store.export(), /LEDGER_CORRUPT/);
  } finally { raw.close(); f.store.close(); }
});
