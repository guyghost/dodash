import { describe, expect, it } from "vitest";
import { initializeP7Ledger } from "./p7-prospective-ledger.js";
import { applyP7MarkCommand, emptyP7MarkState, reportP7MarkCoverage, planP7MarkRecovery, evaluateP7MarkCommitClock } from "./p7-prospective-marks.js";
const start = Date.UTC(2026, 9, 16), HOUR = 3_600_000;
const manifest = { purpose: "LOCAL_PREPARATION" as const, campaignId: "mark-fixture", manifestSha256: "a".repeat(64),
  startAt: start, endAt: start + 180 * 86_400_000, sourceProfileId: "fixture", clockVerified: true };
const initialized = initializeP7Ledger(manifest, start - 1);
if (!initialized.ok) throw new Error(initialized.error);
const ledger = initialized.value;
const cmd = (type: "EXPECT_MARK" | "REQUEST_MARK" | "OBSERVE_MARK", scheduledAt = start) => ({ campaignId: manifest.campaignId,
  commandId: type, scheduledAt, event: type === "OBSERVE_MARK" ? { type, books: { "BTC-USD": null, "ETH-USD": null } } : { type } });
const next = (state: ReturnType<typeof emptyP7MarkState>, type: "EXPECT_MARK" | "REQUEST_MARK" | "OBSERVE_MARK", at = start, scheduledAt = start) => {
  const result = applyP7MarkCommand(state, ledger, cmd(type, scheduledAt), at);
  if (!result.ok) throw new Error(result.error);
  return result.value.state;
};
const complete = (scheduledAt = start) => next(next(next(emptyP7MarkState(), "EXPECT_MARK", scheduledAt, scheduledAt), "REQUEST_MARK", scheduledAt, scheduledAt), "OBSERVE_MARK", scheduledAt + 1, scheduledAt);
describe("P7 hourly mark facts", () => {
  it("marks known flat cash without making a market availability claim", () => {
    const state = complete();
    expect(state.slots[String(start)]?.observation?.consolidated).toMatchObject({ available: true, equity: 20_000 });
    expect(state.slots[String(start)]?.observation?.marks.every((m) => m.available && m.source === "CASH")).toBe(true);
    expect(ledger.portfolios["BTC-USD"]).toEqual({ cash: 10_000, positionQuantity: 0, version: 0 });
  });
  it("does not backdate asOf to its hourly key", () => {
    const state = complete();
    expect(state.slots[String(start)]?.observation?.asOf).toBe(start + 1);
  });
  it("rejects response in an expired hour or a repeated observation", () => {
    const requested = next(next(emptyP7MarkState(), "EXPECT_MARK"), "REQUEST_MARK");
    expect(applyP7MarkCommand(requested, ledger, cmd("OBSERVE_MARK"), start + HOUR).ok).toBe(false);
    expect(applyP7MarkCommand(complete(), ledger, cmd("OBSERVE_MARK"), start + 2).ok).toBe(false);
  });
  it("requires the request checkpoint and keeps missing response suspended", () => {
    const expected = next(emptyP7MarkState(), "EXPECT_MARK");
    expect(applyP7MarkCommand(expected, ledger, cmd("OBSERVE_MARK"), start).ok).toBe(false);
    const requested = next(expected, "REQUEST_MARK");
    expect(planP7MarkRecovery(requested, start).action).toBe("SUSPEND");
    expect(planP7MarkRecovery(complete(), start).action).toBe("DONE");
  });
  it("rejects malformed calendar and caller balances", () => {
    for (const scheduledAt of [start - HOUR, start + 1, manifest.endAt])
      expect(applyP7MarkCommand(emptyP7MarkState(), ledger, cmd("EXPECT_MARK", scheduledAt), start).ok).toBe(false);
    expect(applyP7MarkCommand(emptyP7MarkState(), ledger, { ...cmd("EXPECT_MARK"), portfolio: {} }, start).ok).toBe(false);
  });
  it("keeps an open position without books UNAVAILABLE, not flat cash", () => {
    const requested = next(next(emptyP7MarkState(), "EXPECT_MARK"), "REQUEST_MARK");
    const withPosition = { ...ledger, portfolios: { ...ledger.portfolios, "BTC-USD": { cash: 100, positionQuantity: 1, version: 1 } } };
    const result = applyP7MarkCommand(requested, withPosition, cmd("OBSERVE_MARK"), start + 1);
    expect(result.ok && result.value.receipt.observation?.consolidated).toEqual({ available: false, equity: null });
  });
  it("counts unregistered hours independently of the ledger events", () => {
    const report = reportP7MarkCoverage(complete(), manifest, start + 3 * HOUR);
    expect(report).toMatchObject({ expectedTotal: 4320, expectedToDate: 3, available: 1, unavailable: 0, unobserved: 2, coverage: 1 / 3 });
    expect(reportP7MarkCoverage(emptyP7MarkState(), manifest, start)).toMatchObject({ expectedToDate: 0, coverage: null });
    expect(reportP7MarkCoverage(emptyP7MarkState(), manifest, manifest.endAt)).toMatchObject({ expectedToDate: 4320, unobserved: 4320 });
  });
  it("keeps the 2h boundary strict and a historic gap after a fresh mark", () => {
    expect(reportP7MarkCoverage(emptyP7MarkState(), manifest, start + 2 * HOUR).proofGapExceeded).toBe(false);
    expect(reportP7MarkCoverage(emptyP7MarkState(), manifest, start + 2 * HOUR + 1).proofGapExceeded).toBe(true);
    expect(reportP7MarkCoverage(complete(start + 3 * HOUR), manifest, start + 3 * HOUR + 1).proofGapExceeded).toBe(true);
  });
  it("exposes completed holes and the current hour without an anticipatory failure", () => {
    const report = reportP7MarkCoverage(complete(), manifest, start + HOUR);
    expect(report.currentHourScheduledAt).toBe(start + HOUR);
    expect(report.currentHourStatus).toBe("UNOBSERVED");
    expect(report.unobserved).toBe(0);
    expect(reportP7MarkCoverage(complete(), manifest, start + 3 * HOUR).missingScheduledAt).toEqual([start + HOUR, start + 2 * HOUR]);
    expect(reportP7MarkCoverage(emptyP7MarkState(), manifest, manifest.endAt + HOUR).throughAt).toBe(manifest.endAt);
  });
  it("does not regress its own clock even with a stale ledger input", () => {
    const expected = next(emptyP7MarkState(), "EXPECT_MARK", start + 2);
    expect(applyP7MarkCommand(expected, ledger, cmd("REQUEST_MARK"), start + 1).ok).toBe(false);
  });
  it("rejects a regressing pre-COMMIT clock even for cash-only observations", () => {
    const receipt = complete().slots[String(start)];
    if (!receipt) throw new Error("missing fixture");
    expect(evaluateP7MarkCommitClock(cmd("OBSERVE_MARK"), receipt, manifest, start + 1, start)).toBe("COMMIT_CLOCK_INVALID");
    expect(evaluateP7MarkCommitClock(cmd("OBSERVE_MARK"), receipt, manifest, start + 1, start + HOUR)).toBe("MARK_EXPIRED_BEFORE_COMMIT");
  });
});
