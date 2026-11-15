import { describe, expect, it } from "vitest";
import { assessP7CampaignSnapshot, type P7AssessmentSnapshot } from "./p7-prospective-assessment.js";
import { initializeP7Ledger } from "./p7-prospective-ledger.js";
import { emptyP7MarkState, type P7MarkSlot } from "./p7-prospective-marks.js";
import { emptyP7EventMarks } from "./p7-prospective-event-marks.js";
import { emptyP7BenchmarkEntries } from "./p7-prospective-benchmark-entry.js";
const start = Date.UTC(2026, 9, 16), day = 86_400_000;
const fixture = (days: 30 | 90 | 180 = 180, equity = 21_000): P7AssessmentSnapshot => {
  const initialized = initializeP7Ledger({ purpose: "LOCAL_PREPARATION", campaignId: "assessment", manifestSha256: "a".repeat(64),
    startAt: start, endAt: start + 180 * day, sourceProfileId: "fixture", clockVerified: true }, start - 1);
  if (!initialized.ok) throw new Error(initialized.error);
  const state = { ...initialized.value, slots: { ...initialized.value.slots } }, entries: P7AssessmentSnapshot["entries"][number][] = [];
  for (let i = 0; i < days; i++) for (const productId of ["BTC-USD", "ETH-USD"] as const) {
    const candleClosedAt = start + i * day;
    state.slots[`${productId}:${candleClosedAt}`] = { productId, candleClosedAt, phase: "terminal", revision: 3,
      admission: { evaluatedAt: candleClosedAt, windowSha256: "b".repeat(64), portfolioVersion: 0 }, intent: null, requestedAt: null, quote: null, outcome: { kind: "HOLD" } };
    entries.push({ sequence: entries.length + 1, recordedAt: candleClosedAt, command: { campaignId: "assessment", commandId: `${productId}-${i}`, productId, candleClosedAt, event: { type: "EXPECT" } } });
  }
  const markState = { ...emptyP7MarkState(), slots: {} as Record<string, P7MarkSlot> };
  for (let i = 0; i < days * 24; i++) {
    const asOf = start + i * 3_600_000;
    markState.slots[String(asOf)] = { scheduledAt: asOf, phase: "observed", requestedAt: asOf, observation: {
      asOf, marks: [], consolidated: { available: true, equity, asOf }, portfolios: state.portfolios } };
  }
  const eventMarkState = { ...emptyP7EventMarks(), active: true, slots: { FINAL: {
    markId: "FINAL", kind: "FINAL" as const, fillSequence: null, expectedAt: state.manifest.endAt, phase: "observed" as const, requestedAt: state.manifest.endAt - 1,
    portfolios: state.portfolios, benchmarks: null, observation: { asOf: state.manifest.endAt, marks: [],
      consolidated: { available: true as const, equity, asOf: state.manifest.endAt }, portfolios: state.portfolios },
    benchmarkObservation: { asOf: state.manifest.endAt, marks: [], consolidated: { available: true as const, equity: 22_000, asOf: state.manifest.endAt },
      portfolios: { "BTC-USD": { cash: 9900, positionQuantity: 1, version: 0 }, "ETH-USD": { cash: 9900, positionQuantity: 1, version: 0 } } },
  } } };
  const leg = { phase: "initialized" as const, attempt: 1, requestedAt: start, profileSha256: "b".repeat(64), book: null, bodySha256: "c".repeat(64),
    quoteCommandId: "fixture", eligibility: null, reason: null, quantity: 1, vwap: 100, fill: { price: 100, quantity: 1, fee: 0.6, executedAt: start }, portfolio: { cash: 9900, positionQuantity: 1 } };
  return { observation: "SYNTHETIC_LOCAL_PREPARATION", state, entries, markState, benchmarkMarkState: markState, eventMarkState,
    benchmarkEntries: { ...emptyP7BenchmarkEntries(), active: true, products: { "BTC-USD": leg, "ETH-USD": leg } }, jointMode: true,
    campaignState: { phase: "ended", boundAt: start, lastEvaluatedAt: start + days * day, maxDrawdown: 0, reasons: [] } };
};
describe("fixed-horizon synthetic assessment", () => {
  it("qualifies a complete synthetic fixture but never claims a real verdict", () => {
    const report = assessP7CampaignSnapshot(fixture(), 180);
    expect(report.syntheticVerdict).toBe("PROSPECTIVE_OBSERVATION_FAVORABLE");
    expect(report.prospectiveVerdict).toBeNull();
    expect(report.technical.localQualified).toBe(true);
    expect(report.economics.p7?.netReturn).toBeCloseTo(0.05);
    expect(report.economics.underperformsBuyAndHold).toBe(true);
  });
  it("J30 and J90 remain descriptive regardless of positive returns", () => {
    for (const checkpoint of [30, 90] as const) {
      const report = assessP7CampaignSnapshot(fixture(checkpoint), checkpoint);
      expect(report.syntheticVerdict).toBeNull();
      expect(report.daily.expected).toBe(checkpoint * 2);
      expect(report.machinePhase).toBe("reported");
    }
  });
  it("preserves drawdown failure and gives accounting invalidity precedence", () => {
    const snapshot = fixture();
    const stopped = { ...snapshot, campaignState: { ...snapshot.campaignState, maxDrawdown: 0.51, reasons: ["SAMPLED_DRAWDOWN_EXCEEDED"] } };
    expect(assessP7CampaignSnapshot(stopped, 180).syntheticVerdict).toBe("PROSPECTIVE_OBSERVATION_UNFAVORABLE");
    expect(assessP7CampaignSnapshot({ ...stopped, campaignState: { ...stopped.campaignState, phase: "invalid" } }, 180).syntheticVerdict).toBe("INVALID_CAMPAIGN");
  });
  it("never substitutes hourly history for a missing FINAL", () => {
    const snapshot = fixture();
    const report = assessP7CampaignSnapshot({ ...snapshot, eventMarkState: emptyP7EventMarks() }, 180);
    expect(report.syntheticVerdict).toBe("INCONCLUSIVE");
    expect(report.economics.p7).toBeNull();
  });
  it("keeps missing calendar slots even when unregistered", () => {
    const snapshot = fixture(), slots = { ...snapshot.state.slots };
    delete slots[`BTC-USD:${start}`];
    const report = assessP7CampaignSnapshot({ ...snapshot, state: { ...snapshot.state, slots } }, 180);
    expect(report.daily.unobserved).toBe(1);
    expect(report.syntheticVerdict).toBe("INCONCLUSIVE");
  });
  it("keeps the frozen 99 percent admission boundary", () => {
    const snapshot = fixture();
    const missed = (count: number) => {
      const slots = { ...snapshot.state.slots };
      for (const key of Object.keys(slots).slice(0, count)) slots[key] = { ...slots[key]!, admission: null, outcome: { kind: "MISSED" } };
      return assessP7CampaignSnapshot({ ...snapshot, state: { ...snapshot.state, slots } }, 180);
    };
    expect(missed(3).technical.localQualified).toBe(true);
    expect(missed(4).technical.localQualified).toBe(false);
  });
  it("preserves hourly holes and the exact two-hour gap boundary", () => {
    const snapshot = fixture();
    const holes = (count: number) => {
      const slots = { ...snapshot.benchmarkMarkState.slots };
      for (let i = 1; i <= count; i++) delete slots[String(start + i * 90 * 3_600_000)];
      return assessP7CampaignSnapshot({ ...snapshot, benchmarkMarkState: { ...snapshot.benchmarkMarkState, slots } }, 180);
    };
    expect(holes(43).technical.localQualified).toBe(true);
    expect(holes(43).coverage.buyAndHold.maxGapMs).toBe(7_200_000);
    expect(holes(44).technical.localQualified).toBe(false);
  });
  it("requires strictly positive returns and permits drawdown exactly 50 percent", () => {
    expect(assessP7CampaignSnapshot(fixture(180, 20_000), 180).syntheticVerdict).toBe("PROSPECTIVE_OBSERVATION_UNFAVORABLE");
    const snapshot = fixture();
    expect(assessP7CampaignSnapshot({ ...snapshot, campaignState: { ...snapshot.campaignState, maxDrawdown: 0.5 } }, 180).syntheticVerdict).toBe("PROSPECTIVE_OBSERVATION_FAVORABLE");
  });
  it("never attributes a negative cash invariant to strategy losses", () => {
    const snapshot = fixture();
    const state = { ...snapshot.state, portfolios: { ...snapshot.state.portfolios,
      "BTC-USD": { ...snapshot.state.portfolios["BTC-USD"], cash: -1 } } };
    expect(assessP7CampaignSnapshot({ ...snapshot, state }, 180).syntheticVerdict).toBe("INVALID_CAMPAIGN");
  });
  it("an operator interruption stays inconclusive despite positive final economics", () => {
    const snapshot = fixture();
    const report = assessP7CampaignSnapshot({ ...snapshot, campaignState: { ...snapshot.campaignState, phase: "stopped", reasons: ["LOCAL_OPERATOR_STOP"] } }, 180);
    expect(report.syntheticVerdict).toBe("INCONCLUSIVE");
    expect(report.technical.localQualified).toBe(false);
  });
});
