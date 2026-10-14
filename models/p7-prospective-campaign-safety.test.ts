import { describe, expect, it } from "vitest";
import { initializeP7Ledger } from "./p7-prospective-ledger.js";
import { emptyP7MarkState, type P7MarkState } from "./p7-prospective-marks.js";
import { initialP7LocalCampaign, applyP7LocalCampaignCommand, evaluateP7LocalCampaignSafety } from "./p7-prospective-campaign-safety.js";
const start = Date.UTC(2026, 9, 16), HOUR = 3_600_000;
const manifest = { purpose: "LOCAL_PREPARATION" as const, campaignId: "safety-fixture", manifestSha256: "a".repeat(64),
  startAt: start, endAt: start + 180 * 86_400_000, sourceProfileId: "fixture", clockVerified: true };
const initialized = initializeP7Ledger(manifest, start - 1);
if (!initialized.ok) throw new Error(initialized.error);
const ledger = initialized.value, marks = emptyP7MarkState();
const command = (type: string) => ({ campaignId: manifest.campaignId, commandId: type, event: { type } });
const observing = () => {
  const result = applyP7LocalCampaignCommand(initialP7LocalCampaign(start - 1), ledger, marks, command("BEGIN_LOCAL_SIMULATION"), start);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const marked = (equities: readonly number[]): P7MarkState => ({ ...marks, slots: Object.fromEntries(equities.map((equity, i) =>
  [String(start + i * HOUR), { scheduledAt: start + i * HOUR, phase: "observed", requestedAt: start + i * HOUR,
    observation: { asOf: start + i * HOUR, marks: [], consolidated: { available: true, equity, asOf: start + i * HOUR }, portfolios: ledger.portfolios } }])) });
describe("P7 synthetic campaign safety", () => {
  it("never exposes START_AUTHORIZED or a resume event", () => {
    for (const type of ["START_AUTHORIZED", "RESUME", "BEGIN_LOCAL_SIMULATION"]) {
      const state = type === "BEGIN_LOCAL_SIMULATION" ? observing() : initialP7LocalCampaign(start - 1);
      expect(applyP7LocalCampaignCommand(state, ledger, marks, command(type), start).ok).toBe(false);
    }
  });
  it("requires a local manifest, clock verification and start window", () => {
    for (const [l, at] of [[ledger, start - 1], [ledger, manifest.endAt], [{ ...ledger, manifest: { ...manifest, clockVerified: false } }, start]] as const)
      expect(applyP7LocalCampaignCommand(initialP7LocalCampaign(start - 1), l, marks, command("BEGIN_LOCAL_SIMULATION"), at).ok).toBe(false);
  });
  it("suspends only beyond the strict 2h boundary", () => {
    expect(evaluateP7LocalCampaignSafety(observing(), ledger, marks, start + 2 * HOUR).phase).toBe("localObserving");
    expect(evaluateP7LocalCampaignSafety(observing(), ledger, marks, start + 2 * HOUR + 1).phase).toBe("suspended");
  });
  it("keeps a suspension sticky after fresh proofs arrive", () => {
    const state = evaluateP7LocalCampaignSafety(observing(), ledger, marks, start + 2 * HOUR + 1);
    expect(evaluateP7LocalCampaignSafety(state, ledger, marked([20_000, 20_000, 20_000]), start + 2 * HOUR + 2).phase).toBe("suspended");
  });
  it("stops above 50% sampled drawdown, not exactly at 50%", () => {
    expect(evaluateP7LocalCampaignSafety(observing(), ledger, marked([20_000, 10_000]), start + HOUR).phase).toBe("localObserving");
    const stopped = evaluateP7LocalCampaignSafety(observing(), ledger, marked([20_000, 9_999, 20_000]), start + 2 * HOUR);
    expect(stopped.phase).toBe("stopped");
    expect(stopped.reasons).toContain("SAMPLED_DRAWDOWN_EXCEEDED");
  });
  it("invalidates accounting invariants rather than calling them an economic loss", () => {
    const broken = { ...ledger, portfolios: { ...ledger.portfolios, "BTC-USD": { cash: -1, positionQuantity: 0, version: 0 } } };
    expect(evaluateP7LocalCampaignSafety(observing(), broken, marks, start).phase).toBe("invalid");
  });
  it("distinguishes an in-flight request from a lost response at recovery", () => {
    const pending: P7MarkState = { ...marks, slots: { [start]: { scheduledAt: start, phase: "requested", requestedAt: start, observation: null } } };
    expect(evaluateP7LocalCampaignSafety(observing(), ledger, pending, start).phase).toBe("localObserving");
    const result = applyP7LocalCampaignCommand(observing(), ledger, pending, command("RECOVER_LOCAL"), start);
    expect(result.ok && result.value.phase).toBe("suspended");
  });
  it("ends at T1 without a liquidation and preserves operator stop", () => {
    expect(evaluateP7LocalCampaignSafety(observing(), ledger, marks, manifest.endAt).phase).toBe("ended");
    const stop = applyP7LocalCampaignCommand(observing(), ledger, marks, command("STOP_LOCAL"), start);
    if (!stop.ok) throw new Error(stop.error);
    expect(evaluateP7LocalCampaignSafety(stop.value, ledger, marks, manifest.endAt).phase).toBe("stopped");
    expect(ledger.portfolios["BTC-USD"].positionQuantity).toBe(0);
  });
  it("rejects regressing clocks and caller-supplied safety decisions", () => {
    expect(() => evaluateP7LocalCampaignSafety(observing(), ledger, marks, start - 1)).toThrow("INVALID_CAMPAIGN_CLOCK");
    expect(applyP7LocalCampaignCommand(observing(), ledger, marks, { ...command("CHECK_LOCAL_SAFETY"), phase: "localObserving" }, start).ok).toBe(false);
  });
});
