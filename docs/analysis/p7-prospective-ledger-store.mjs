/** Local synthetic preparation only. No network, broker or campaign-start effect. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { planP7JournalTerminal } from "./p7-prospective-pricing.mjs";
import { verifyP7IndependentBenchmarkFill } from "./p7-prospective-benchmarks.mjs";

const require = createRequire(new URL("../../packages/backtest/package.json", import.meta.url));
const { initializeP7Ledger, applyP7LedgerCommand, planP7LedgerRecovery, isP7PricingCommitRequest, evaluateP7PricingCommitClock,
  emptyP7MarkState, applyP7MarkCommand, evaluateP7MarkCommitClock, planP7MarkRecovery, reportP7MarkCoverage,
  initialP7LocalCampaign, applyP7LocalCampaignCommand, evaluateP7LocalCampaignSafety, registerP7BenchmarkProfile,
  emptyP7BenchmarkEntries, applyP7BenchmarkEntry, recoverP7BenchmarkEntry, applyP7JointMarkCommand } = await import(require.resolve("@dodash/models"));
const ZERO_HASH = "0".repeat(64);
const MAX_BYTES = 2 * 1024 * 1024;
const hash = (body) => createHash("sha256").update(body).digest("hex");
const canonical = (value, depth = 0) => {
  if (depth > 32) throw new Error("INVALID_JSON_DEPTH");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new Error("INVALID_JSON_ARRAY");
    const items = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw new Error("INVALID_JSON_ARRAY");
      items.push(canonical(descriptor.value, depth + 1));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object" && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const keys = Object.keys(value).sort();
    if (keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) throw new Error("INVALID_JSON_ACCESSOR");
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  }
  throw new Error("INVALID_JSON_VALUE");
};
const bounded = (value) => {
  const body = canonical(value);
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("COMMAND_TOO_LARGE");
  return body;
};

const derivePricedCommand = (journal, request, recordedAt) => {
  if (!isP7PricingCommitRequest(request, journal.state.manifest)) throw new Error("INVALID_PRICING_REQUEST");
  const plan = planP7JournalTerminal(journal, request.productId, request.candleClosedAt, recordedAt);
  if (plan.kind !== "TERMINAL_PLAN") throw new Error(plan.kind === "DONE" ? "INVALID_PHASE" : plan.reason);
  return { ...request, event: { type: "TERMINATE", outcome: plan.outcome } };
};
const checkCommitClock = (journal, command, recordedAt, commitCheckedAt) => {
  const quote = journal.entries.find((e) => e.command?.productId === command.productId &&
    e.command.candleClosedAt === command.candleClosedAt && e.command.event.type === "OBSERVE_QUOTE");
  const error = evaluateP7PricingCommitClock({ recordedAt, commitCheckedAt, sourceObservedAt: quote?.command.event.book?.sourceObservedAt,
    candleClosedAt: command.candleClosedAt, campaignEndAt: journal.state.manifest.endAt, simulatedFill: command.event.outcome.kind === "SIMULATED_FILL" });
  if (error !== null) throw new Error(error);
};
const assertLegacyCampaign = (journal, command, mode, now) => {
  if (journal.campaignState.boundAt === null) return;
  if (mode === "pricing") throw new Error("USE_CAMPAIGN_PRICING");
  if (mode !== "fixture") return;
  if (command.event?.type === "TERMINATE" && command.event.outcome?.kind === "SIMULATED_FILL") throw new Error("LEGACY_FILL_DISABLED");
  if (["INTENT", "REQUEST_QUOTE"].includes(command.event?.type) &&
    evaluateSafety(journal, now).phase !== "localObserving") throw new Error("CAMPAIGN_SAFETY_BLOCKED");
};
const resolveCampaignPricing = (journal, request, now) => {
  if (!isP7PricingCommitRequest(request, journal.state.manifest)) throw new Error("INVALID_PRICING_REQUEST");
  const campaign = evaluateSafety(journal, now);
  if (campaign.phase !== "localObserving") return { state: { ...journal.state, lastRecordedAt: now }, campaignState: campaign,
    resolution: null, receipt: { allowed: false, campaign } };
  const resolution = derivePricedCommand(journal, request, now), result = applyP7LedgerCommand(journal.state, resolution, now);
  if (!result.ok) throw new Error(result.error);
  return { state: result.value.state, campaignState: campaign, resolution, receipt: { allowed: true, receipt: result.value.receipt, campaign } };
};
const checkCampaignPricingClock = (journal, resolved, recordedAt, checkedAt) => {
  const safety = evaluateSafety({ ...journal, campaignState: resolved.campaignState, state: resolved.state }, checkedAt);
  if (resolved.receipt.allowed && safety.phase !== "localObserving") throw new Error("CAMPAIGN_BLOCKED_BEFORE_COMMIT");
  if (resolved.resolution !== null) checkCommitClock(journal, resolved.resolution, recordedAt, checkedAt);
};
const pendingBenchmark = (entries) => Object.values(entries.products).some((leg) => leg?.phase === "requested");
const evaluateSafety = (journal, now) => evaluateP7LocalCampaignSafety(journal.campaignState, journal.state, journal.markState, now,
  false, false, journal.jointMode ? journal.benchmarkMarkState : null);
const checkMarkClock = (command, receipt, manifest, recordedAt, checkedAt) => {
  const error = evaluateP7MarkCommitClock(command, receipt, manifest, recordedAt, checkedAt);
  if (error !== null) return error;
  return receipt.benchmarkObservation === undefined ? null : evaluateP7MarkCommitClock(command,
    { ...receipt, observation: receipt.benchmarkObservation }, manifest, recordedAt, checkedAt);
};
const initialMarketPublished = (journal) => journal.entries.some((e) =>
  (e.command?.event?.type === "OBSERVE_QUOTE" && e.command.candleClosedAt === journal.state.manifest.startAt) ||
  (e.command?.event?.type === "OBSERVE_MARK" && e.command.scheduledAt === journal.state.manifest.startAt));
const checkBenchmarkEntryClock = (journal, command, leg, recordedAt, checkedAt) => {
  if (!Number.isSafeInteger(checkedAt) || checkedAt < recordedAt) throw new Error("COMMIT_CLOCK_INVALID");
  if (command.event.type === "REQUEST_BENCHMARK" && (checkedAt > journal.state.manifest.startAt + 7_200_000 || checkedAt >= journal.state.manifest.endAt)) throw new Error("BENCHMARK_ENTRY_BLOCKED");
  if (journal.jointMode && command.event.type === "REQUEST_BENCHMARK" && evaluateSafety(journal, checkedAt).phase !== "localObserving") throw new Error("BENCHMARK_BLOCKED_BEFORE_COMMIT");
  if (command.event.type !== "RESOLVE_BENCHMARK" || leg.phase !== "initialized") return;
  if (evaluateSafety(journal, checkedAt).phase !== "localObserving") throw new Error("BENCHMARK_BLOCKED_BEFORE_COMMIT");
  const error = evaluateP7PricingCommitClock({ recordedAt, commitCheckedAt: checkedAt, sourceObservedAt: leg.book?.sourceObservedAt,
    candleClosedAt: journal.state.manifest.startAt, campaignEndAt: journal.state.manifest.endAt, simulatedFill: true });
  if (error !== null) throw new Error(error);
};

export class P7LocalLedgerStore {
  #database;
  #now;
  #failpoint;
  constructor(path, manifest, { now = Date.now, failpoint } = {}) {
    const existed = path !== ":memory:" && existsSync(path);
    this.#database = new DatabaseSync(path);
    this.#now = now; this.#failpoint = failpoint;
    try {
      if (existed && this.#database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='p7_ledger'").get() === undefined) throw new Error("FOREIGN_DATABASE");
      this.#database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS p7_ledger (
          sequence INTEGER PRIMARY KEY, command_id TEXT NOT NULL UNIQUE,
          body TEXT NOT NULL, hash TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS p7_ledger_no_update BEFORE UPDATE ON p7_ledger
          BEGIN SELECT RAISE(ABORT, 'append-only ledger'); END;
        CREATE TRIGGER IF NOT EXISTS p7_ledger_no_delete BEFORE DELETE ON p7_ledger
          BEGIN SELECT RAISE(ABORT, 'append-only ledger'); END;
      `);
      const normalized = JSON.parse(bounded(manifest));
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        if (this.#database.prepare("SELECT sequence FROM p7_ledger LIMIT 1").get() === undefined) {
          const recordedAt = this.#now(), initialized = initializeP7Ledger(normalized, recordedAt);
          if (!initialized.ok) throw new Error(initialized.error);
          const entry = { schemaVersion: 1, observation: "SYNTHETIC_LOCAL_PREPARATION", sequence: 1,
            previousHash: ZERO_HASH, recordedAt, manifest: normalized };
          this.#insert("__manifest__", entry);
        }
        if (canonical(this.#read().state.manifest) !== canonical(normalized)) throw new Error("MANIFEST_CONFLICT");
        this.#database.exec("COMMIT");
      } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
    } catch (error) { this.#database.close(); throw error; }
  }
  #insert(commandId, entry) {
    const body = canonical(entry);
    this.#database.prepare("INSERT INTO p7_ledger(sequence, command_id, body, hash) VALUES (?, ?, ?, ?)").run(entry.sequence, commandId, body, hash(body));
  }
  #read() {
    let state, lastHash = ZERO_HASH;
    let campaignState;
    let benchmarkProfile = null;
    let benchmarkEntries = emptyP7BenchmarkEntries();
    let markState = emptyP7MarkState();
    let benchmarkMarkState = emptyP7MarkState(), jointMode = false;
    const entries = [], ids = new Set();
    try {
      for (const row of this.#database.prepare("SELECT sequence, command_id, body, hash FROM p7_ledger ORDER BY sequence").iterate()) {
        if (Buffer.byteLength(row.body) > MAX_BYTES + 65_536 || row.sequence !== entries.length + 1 || hash(row.body) !== row.hash || ids.has(row.command_id)) throw new Error("LEDGER_CORRUPT");
        const entry = JSON.parse(row.body);
        if (canonical(entry) !== row.body || ![1, 2, 3, 4, 5, 6, 7, 8].includes(entry.schemaVersion) || entry.observation !== "SYNTHETIC_LOCAL_PREPARATION" || entry.sequence !== row.sequence || entry.previousHash !== lastHash) throw new Error("LEDGER_CORRUPT");
        if (row.sequence !== 1 && (entry.manifest !== undefined || row.command_id !== entry.command?.commandId)) throw new Error("LEDGER_CORRUPT");
        if (row.sequence === 1) {
          if (entry.schemaVersion !== 1 || row.command_id !== "__manifest__" || entry.command !== undefined) throw new Error("LEDGER_CORRUPT");
          const initialized = initializeP7Ledger(entry.manifest, entry.recordedAt);
          if (!initialized.ok) throw new Error("LEDGER_CORRUPT");
          state = initialized.value;
          campaignState = initialP7LocalCampaign(entry.recordedAt);
        } else if (entry.schemaVersion === 8) {
          if (!jointMode && entry.command.event.type !== "EXPECT_MARK") throw new Error("LEDGER_CORRUPT");
          const result = applyP7JointMarkCommand(markState, benchmarkMarkState, state, benchmarkEntries, entry.command, entry.recordedAt);
          if (!result.ok || canonical(result.value.receipt) !== canonical(entry.receipt) ||
            checkMarkClock(entry.command, entry.receipt, state.manifest, entry.recordedAt, entry.markCheckedAt) !== null) throw new Error("LEDGER_CORRUPT");
          jointMode = true; markState = result.value.state; benchmarkMarkState = result.value.benchmarkState;
          state = { ...state, lastRecordedAt: entry.recordedAt };
        } else if (entry.schemaVersion === 7) {
          const prior = { state, campaignState, markState, jointMode, benchmarkMarkState };
          const safety = evaluateSafety(prior, entry.recordedAt);
          const result = applyP7BenchmarkEntry(benchmarkEntries, state, benchmarkProfile, safety.phase, entry.command, entry.recordedAt, initialMarketPublished({ state, entries }));
          if (!result.ok || canonical(result.value.receipt) !== canonical(entry.receipt)) throw new Error("LEDGER_CORRUPT");
          verifyP7IndependentBenchmarkFill(result.value.receipt, entry.command.productId);
          checkBenchmarkEntryClock(prior, entry.command, result.value.receipt, entry.recordedAt, entry.entryCheckedAt);
          benchmarkEntries = result.value.state;
          state = { ...state, lastRecordedAt: entry.recordedAt };
        } else if (entry.schemaVersion === 6) {
          const result = registerP7BenchmarkProfile(benchmarkProfile, state.manifest, entry.command, entry.recordedAt);
          if (!result.ok || entry.recordedAt < state.lastRecordedAt || canonical(result.value) !== canonical(entry.receipt) ||
            !Number.isSafeInteger(entry.benchmarkCheckedAt) || entry.benchmarkCheckedAt < entry.recordedAt || entry.benchmarkCheckedAt >= state.manifest.startAt) throw new Error("LEDGER_CORRUPT");
          benchmarkProfile = result.value;
          state = { ...state, lastRecordedAt: entry.recordedAt };
        } else if (entry.schemaVersion === 4) {
          const result = applyP7LocalCampaignCommand(campaignState, state, markState, entry.command, entry.recordedAt, pendingBenchmark(benchmarkEntries), jointMode ? benchmarkMarkState : null);
          if (!result.ok || canonical(result.value) !== canonical(entry.receipt)) throw new Error("LEDGER_CORRUPT");
          campaignState = result.value;
          state = { ...state, lastRecordedAt: entry.recordedAt };
        } else if (entry.schemaVersion === 5) {
          const prior = { observation: "SYNTHETIC_LOCAL_PREPARATION", state, entries, markState, campaignState, jointMode, benchmarkMarkState };
          const resolved = resolveCampaignPricing(prior, entry.command, entry.recordedAt);
          if (canonical(resolved.receipt) !== canonical(entry.receipt) || canonical(resolved.resolution) !== canonical(entry.resolution)) throw new Error("LEDGER_CORRUPT");
          checkCampaignPricingClock(prior, resolved, entry.recordedAt, entry.guardedCheckedAt);
          state = resolved.state; campaignState = resolved.campaignState;
        } else if (entry.schemaVersion === 3) {
          if (jointMode) throw new Error("LEDGER_CORRUPT");
          if (entry.manifest !== undefined || entry.pricingRequest !== undefined || entry.pricingCheckedAt !== undefined || row.command_id !== entry.command?.commandId) throw new Error("LEDGER_CORRUPT");
          const result = applyP7MarkCommand(markState, state, entry.command, entry.recordedAt);
          if (!result.ok || canonical(result.value.receipt) !== canonical(entry.receipt) ||
            evaluateP7MarkCommitClock(entry.command, result.value.receipt, state.manifest, entry.recordedAt, entry.markCheckedAt) !== null) throw new Error("LEDGER_CORRUPT");
          markState = result.value.state;
          state = { ...state, lastRecordedAt: entry.recordedAt };
        } else {
          if (entry.markCheckedAt !== undefined) throw new Error("LEDGER_CORRUPT");
          if (entry.manifest !== undefined || row.command_id !== entry.command?.commandId) throw new Error("LEDGER_CORRUPT");
          assertLegacyCampaign({ state, entries, markState, campaignState, jointMode, benchmarkMarkState }, entry.command, entry.schemaVersion === 2 ? "pricing" : "fixture", entry.recordedAt);
          if (entry.schemaVersion === 2) {
            const prior = { observation: "SYNTHETIC_LOCAL_PREPARATION", state, entries };
            const derived = derivePricedCommand(prior, entry.pricingRequest, entry.recordedAt);
            if (canonical(derived) !== canonical(entry.command)) throw new Error("LEDGER_CORRUPT");
            checkCommitClock(prior, derived, entry.recordedAt, entry.pricingCheckedAt);
          } else if (entry.pricingRequest !== undefined || entry.pricingCheckedAt !== undefined) throw new Error("LEDGER_CORRUPT");
          const result = applyP7LedgerCommand(state, entry.command, entry.recordedAt);
          if (!result.ok || canonical(result.value.receipt) !== canonical(entry.receipt)) throw new Error("LEDGER_CORRUPT");
          state = result.value.state;
        }
        campaignState = evaluateSafety({ campaignState, state, markState, jointMode, benchmarkMarkState }, entry.recordedAt);
        ids.add(row.command_id); entries.push(entry); lastHash = row.hash;
      }
      if (state === undefined) throw new Error("LEDGER_CORRUPT");
      return { observation: "SYNTHETIC_LOCAL_PREPARATION", entries, lastHash, state, markState, campaignState, benchmarkProfile, benchmarkEntries, jointMode, benchmarkMarkState };
    } catch { throw new Error("LEDGER_CORRUPT"); }
  }
  apply(command) {
    return this.#apply(command, "fixture");
  }
  commitPricing(request) {
    return this.#apply(request, "pricing");
  }
  applyMark(command) {
    return this.#apply(command, "mark");
  }
  applyCampaign(command) { return this.#apply(command, "campaign"); }
  commitCampaignPricing(request) { return this.#apply(request, "guarded"); }
  registerBenchmarks(command) { return this.#apply(command, "benchmark"); }
  applyBenchmarkEntry(command) { return this.#apply(command, "benchmark-entry"); }
  applyJointMark(command) { return this.#apply(command, "joint-mark"); }
  #apply(input, mode) {
    const joint = mode === "joint-mark";
    const priced = mode === "pricing", marked = mode === "mark" || joint, guarded = mode === "guarded", campaign = mode === "campaign";
    const benchmark = mode === "benchmark", benchmarkEntry = mode === "benchmark-entry";
    const schemaVersion = joint ? 8 : benchmarkEntry ? 7 : benchmark ? 6 : guarded ? 5 : campaign ? 4 : marked ? 3 : priced ? 2 : 1;
    const body = bounded(input), normalized = JSON.parse(body);
    if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized) || typeof normalized.commandId !== "string") throw new Error("INVALID_COMMAND");
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const journal = this.#read();
      if (priced && !isP7PricingCommitRequest(normalized, journal.state.manifest)) throw new Error("INVALID_PRICING_REQUEST");
      const previous = journal.entries.find((e) => e.command !== undefined && e.command.commandId === normalized.commandId);
      if (previous !== undefined) {
        if (previous.schemaVersion !== schemaVersion || canonical(priced ? previous.pricingRequest : previous.command) !== body) throw new Error("COMMAND_ID_CONFLICT");
        this.#database.exec("COMMIT"); committed = true;
        return previous.receipt;
      }
      const recordedAt = this.#now();
      if (marked && !joint && journal.jointMode) throw new Error("USE_JOINT_MARK");
      if (joint && !journal.jointMode && normalized.event?.type !== "EXPECT_MARK") throw new Error("JOINT_MARK_EXPECT_REQUIRED");
      assertLegacyCampaign(journal, normalized, mode, recordedAt);
      const resolved = guarded ? resolveCampaignPricing(journal, normalized, recordedAt) : null;
      const command = priced ? derivePricedCommand(journal, normalized, recordedAt) : normalized;
      const campaignResult = campaign ? applyP7LocalCampaignCommand(journal.campaignState, journal.state, journal.markState, command, recordedAt, pendingBenchmark(journal.benchmarkEntries), journal.jointMode ? journal.benchmarkMarkState : null) : null;
      let result;
      if (benchmarkEntry) {
        const safety = evaluateSafety(journal, recordedAt);
        result = applyP7BenchmarkEntry(journal.benchmarkEntries, journal.state, journal.benchmarkProfile, safety.phase, command, recordedAt, initialMarketPublished(journal));
        if (result.ok) verifyP7IndependentBenchmarkFill(result.value.receipt, command.productId);
      } else if (benchmark) {
        if (recordedAt < journal.state.lastRecordedAt) throw new Error("INVALID_BENCHMARK_PROFILE");
        const registered = registerP7BenchmarkProfile(journal.benchmarkProfile, journal.state.manifest, command, recordedAt);
        result = registered.ok ? { ok: true, value: { receipt: registered.value } } : registered;
      } else if (guarded) result = { ok: true, value: { receipt: resolved.receipt } };
      else if (campaign) result = campaignResult.ok ? { ok: true, value: { receipt: campaignResult.value } } : campaignResult;
      else if (joint) result = applyP7JointMarkCommand(journal.markState, journal.benchmarkMarkState, journal.state, journal.benchmarkEntries, command, recordedAt);
      else if (marked) result = applyP7MarkCommand(journal.markState, journal.state, command, recordedAt);
      else result = applyP7LedgerCommand(journal.state, command, recordedAt);
      if (!result.ok) throw new Error(result.error);
      const entry = { schemaVersion, observation: "SYNTHETIC_LOCAL_PREPARATION", sequence: journal.entries.length + 1,
        previousHash: journal.lastHash, recordedAt, command, receipt: result.value.receipt,
        ...(priced ? { pricingRequest: normalized, pricingCheckedAt: recordedAt } : {}),
        ...(marked ? { markCheckedAt: recordedAt } : {}),
        ...(guarded ? { resolution: resolved.resolution, guardedCheckedAt: recordedAt } : {}),
        ...(benchmark ? { benchmarkCheckedAt: recordedAt } : {}),
        ...(benchmarkEntry ? { entryCheckedAt: recordedAt } : {}) };
      // Persist the check immediately before INSERT, then repeat it after INSERT.
      // The later wall-clock value is not logged: no UPDATE on append-only facts.
      if (priced) {
        entry.pricingCheckedAt = this.#now();
        checkCommitClock(journal, command, recordedAt, entry.pricingCheckedAt);
      }
      if (marked) {
        entry.markCheckedAt = this.#now();
        const error = checkMarkClock(command, entry.receipt, journal.state.manifest, recordedAt, entry.markCheckedAt);
        if (error !== null) throw new Error(error);
      }
      if (guarded) {
        entry.guardedCheckedAt = this.#now();
        checkCampaignPricingClock(journal, resolved, recordedAt, entry.guardedCheckedAt);
      }
      if (benchmark) {
        entry.benchmarkCheckedAt = this.#now();
        if (!Number.isSafeInteger(entry.benchmarkCheckedAt) || entry.benchmarkCheckedAt < recordedAt || entry.benchmarkCheckedAt >= journal.state.manifest.startAt) throw new Error("BENCHMARK_REGISTRATION_EXPIRED");
      }
      if (benchmarkEntry) {
        entry.entryCheckedAt = this.#now();
        checkBenchmarkEntryClock(journal, command, entry.receipt, recordedAt, entry.entryCheckedAt);
      }
      this.#insert(normalized.commandId, entry);
      this.#failpoint?.("beforeCommit");
      if (priced) {
        const checkedAt = this.#now();
        checkCommitClock(journal, command, recordedAt, checkedAt);
        // The persisted check time precedes insertion; final check is stricter and
        // may only confirm it. No clock regression after the persisted check.
        if (checkedAt < entry.pricingCheckedAt) throw new Error("COMMIT_CLOCK_INVALID");
      }
      if (marked) {
        const checkedAt = this.#now(), error = checkMarkClock(command, entry.receipt, journal.state.manifest, recordedAt, checkedAt);
        if (error !== null) throw new Error(error);
        if (checkedAt < entry.markCheckedAt) throw new Error("COMMIT_CLOCK_INVALID");
      }
      if (guarded) {
        const checkedAt = this.#now();
        checkCampaignPricingClock(journal, resolved, recordedAt, checkedAt);
        if (checkedAt < entry.guardedCheckedAt) throw new Error("COMMIT_CLOCK_INVALID");
      }
      if (benchmark) {
        const checkedAt = this.#now();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < entry.benchmarkCheckedAt || checkedAt >= journal.state.manifest.startAt) throw new Error("BENCHMARK_REGISTRATION_EXPIRED");
      }
      if (benchmarkEntry) {
        const checkedAt = this.#now();
        checkBenchmarkEntryClock(journal, command, entry.receipt, recordedAt, checkedAt);
        if (checkedAt < entry.entryCheckedAt) throw new Error("COMMIT_CLOCK_INVALID");
      }
      this.#database.exec("COMMIT"); committed = true;
      this.#failpoint?.("afterCommit");
      return result.value.receipt;
    } catch (error) {
      if (!committed) this.#database.exec("ROLLBACK");
      throw error;
    }
  }
  export() { return this.#read(); }
  recovery(productId, candleClosedAt, now = this.#now()) { return planP7LedgerRecovery(this.#read().state, productId, candleClosedAt, now); }
  markRecovery(scheduledAt) { return planP7MarkRecovery(this.#read().markState, scheduledAt); }
  benchmarkRecovery(productId) { return recoverP7BenchmarkEntry(this.#read().benchmarkEntries, productId); }
  markCoverage(asOf = this.#now()) {
    const { state, markState } = this.#read();
    return reportP7MarkCoverage(markState, state.manifest, asOf);
  }
  benchmarkMarkCoverage(asOf = this.#now()) {
    const { state, benchmarkMarkState } = this.#read();
    return reportP7MarkCoverage(benchmarkMarkState, state.manifest, asOf);
  }
  close() { this.#database.close(); }
}
