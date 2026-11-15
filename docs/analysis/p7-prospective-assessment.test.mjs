import assert from "node:assert/strict";
import { test } from "node:test";
import { P7LocalLedgerStore } from "./p7-prospective-ledger-store.mjs";
import { assessP7LocalCampaign } from "./p7-prospective-assessment.mjs";
const start = Date.UTC(2026, 9, 16), day = 86_400_000;
const manifest = { purpose: "LOCAL_PREPARATION", campaignId: "assessor-local", manifestSha256: "a".repeat(64),
  startAt: start, endAt: start + 180 * day, sourceProfileId: "fixture", clockVerified: true };
const fixture = () => {
  let now = start - 1;
  const store = new P7LocalLedgerStore(":memory:", manifest, { now: () => now });
  now = start;
  store.applyCampaign({ campaignId: manifest.campaignId, commandId: "begin", event: { type: "BEGIN_LOCAL_SIMULATION" } });
  return { store, setNow: (at) => { now = at; } };
};
test("checkpoints cannot run early or select another horizon", () => {
  const f = fixture();
  try {
    assert.throws(() => assessP7LocalCampaign(f.store, 30), /ASSESSMENT_NOT_DUE/);
    f.setNow(start + 180 * day);
    assert.throws(() => assessP7LocalCampaign(f.store, 42), /INVALID_ASSESSMENT_CHECKPOINT/);
  } finally { f.store.close(); }
});
test("a later diagnostic cannot change a historical J30 report or its hash", () => {
  const f = fixture();
  try {
    f.setNow(start + 30 * day);
    const before = f.store.export(), original = assessP7LocalCampaign(f.store, 30);
    assert.deepEqual(f.store.export(), before);
    f.setNow(start + 45 * day);
    f.store.applyCampaign({ campaignId: manifest.campaignId, commandId: "stop", event: { type: "STOP_LOCAL" } });
    const later = assessP7LocalCampaign(f.store, 30);
    assert.deepEqual(later.report, original.report);
    assert.equal(later.reportSha256, original.reportSha256);
    assert.equal(later.report.source.sequence, 2);
    assert.notEqual(later.generatedAt, original.generatedAt);
  } finally { f.store.close(); }
});
test("unknown daily slots are retained and never reported as zero return", () => {
  const f = fixture();
  try {
    f.setNow(manifest.endAt);
    const before = f.store.export(), { report } = assessP7LocalCampaign(f.store, 180);
    assert.equal(report.daily.expected, 360);
    assert.equal(report.daily.unobserved, 360);
    assert.equal(report.coverage.p7.unobserved, 4320);
    assert.equal(report.syntheticVerdict, "INCONCLUSIVE");
    assert.equal(report.economics.p7, null);
    assert.equal(report.prospectiveVerdict, null);
    assert.equal(report.technical.prospectiveQualified, false);
    assert.deepEqual(f.store.export(), before);
  } finally { f.store.close(); }
});
