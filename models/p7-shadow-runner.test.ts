import { describe, expect, it } from "vitest";
import { transitionP7Shadow } from "./p7-shadow-lifecycle.js";
import {
	applyP7Shadow,
	hasP7InterruptedAdmission,
	initializeP7Shadow,
	P7_DAY,
	planP7ShadowDailyRecovery,
	planP7ShadowDecision,
	planP7ShadowJobs,
	planP7ShadowPricing,
	suspendP7ShadowForRequestGap,
} from "./p7-shadow-runner.js";

const T0 = Date.UTC(2026, 10, 1),
	manifest = {
		purpose: "LOCAL_PREPARATION" as const,
		campaignId: "test",
		manifestSha256: "a".repeat(64),
		startAt: T0,
		endAt: T0 + 180 * P7_DAY,
		sourceProfileId: "fixture",
		clockVerified: true,
	};
const profile = {
	sourceProfileId: "fixture",
	profileSha256: "b".repeat(64),
	quantityDecimals: { "BTC-USD": 8, "ETH-USD": 8 },
};
const init = () => initializeP7Shadow(manifest, profile, T0 - 1);
const authority = {
	purpose: "PROSPECTIVE" as const,
	campaignId: "test",
	sourceProfileId: "fixture",
	codeSha256: "c".repeat(64),
	protocolSha256: "d".repeat(64),
	registeredAt: T0 - 1,
	startAt: T0,
	endAt: manifest.endAt,
	qualifiedSource: true,
	operatorAuthority: "trusted",
};
const caps = {
	enabled: true,
	qualifiedEvidence: true,
	operatorAuthority: "trusted",
};
describe("prospective lifecycle remains separate and guarded", () => {
	it("requires explicit real authority and time window", () => {
		expect(
			transitionP7Shadow("registered", "PREFLIGHT", authority, T0 - 1, caps),
		).toBe("preflight");
		expect(
			transitionP7Shadow("preflight", "READY", authority, T0 - 1, caps),
		).toBe("ready");
		expect(transitionP7Shadow("ready", "START", authority, T0, caps)).toBe(
			"observing",
		);
		expect(() =>
			transitionP7Shadow(
				"ready",
				"START",
				{ ...authority, purpose: "LOCAL_PREPARATION" },
				T0,
				caps,
			),
		).toThrow("DISABLED");
		expect(() =>
			transitionP7Shadow("ready", "START", authority, T0, {
				...caps,
				enabled: false,
			}),
		).toThrow("DISABLED");
		expect(() =>
			transitionP7Shadow("ready", "START", authority, T0, {
				...caps,
				operatorAuthority: "forged",
			}),
		).toThrow("DISABLED");
		expect(() =>
			transitionP7Shadow("ready", "START", authority, T0 - 1, caps),
		).toThrow("WINDOW");
		expect(() =>
			transitionP7Shadow("ready", "START", authority, manifest.endAt, caps),
		).toThrow("WINDOW");
	});
	it("suspends/stops/assesses without resurrecting or early finalization", () => {
		expect(
			transitionP7Shadow("observing", "PROOF_GAP", authority, T0, caps),
		).toBe("suspended");
		expect(transitionP7Shadow("suspended", "STOP", authority, T0, caps)).toBe(
			"stopped",
		);
		expect(() =>
			transitionP7Shadow("stopped", "PERIOD_ENDED", authority, T0, caps),
		).toThrow("NOT_ENDED");
		expect(
			transitionP7Shadow(
				"stopped",
				"PERIOD_ENDED",
				authority,
				manifest.endAt,
				caps,
			),
		).toBe("assessing");
		expect(
			transitionP7Shadow(
				"assessing",
				"ASSESSMENT_COMMITTED",
				authority,
				manifest.endAt,
				caps,
			),
		).toBe("completed");
		expect(() =>
			transitionP7Shadow("completed", "START", authority, T0, caps),
		).toThrow("TRANSITION");
		expect(
			transitionP7Shadow("observing", "INVARIANT_BREACH", authority, T0, caps),
		).toBe("invalid");
		expect(() =>
			transitionP7Shadow("registered", "PREFLIGHT", authority, T0 - 2, caps),
		).toThrow("CLOCK");
	});
});
describe("local durable runner", () => {
	it("validates causal contiguous 240 daily closes without future/synthetic padding", () => {
		const s = init(),
			candles = Array.from({ length: 240 }, (_, i) => ({
				start: T0 - (240 - i) * P7_DAY,
				close: 1000 - i + (i % 2),
			}));
		expect(planP7ShadowDecision(s, "BTC-USD", T0, candles).side).toBe("HOLD");
		expect(() =>
			planP7ShadowDecision(s, "BTC-USD", T0, candles.slice(1)),
		).toThrow("WINDOW");
		expect(() =>
			planP7ShadowDecision(s, "BTC-USD", T0, [
				...candles.slice(0, -1),
				{ start: T0, close: 1 },
			]),
		).toThrow("WINDOW");
		expect(() => planP7ShadowDecision(s, "BTC-USD", T0, null)).toThrow(
			"WINDOW",
		);
	});
	it("pages all 180 days and hourly slots without unbounded command batches", () => {
		let s = init();
		s = {
			...s,
			benchmarks: {
				...s.benchmarks,
				products: {
					"BTC-USD": { ...s.benchmarks.products["BTC-USD"]!, phase: "failed" },
					"ETH-USD": { ...s.benchmarks.products["ETH-USD"]!, phase: "failed" },
				},
			},
			events: { ...s.events, slots: {} },
		};
		const complete = new Set<string>();
		let pages = 0;
		while (true) {
			const page = planP7ShadowJobs(s, manifest.endAt, complete, 32);
			if (!page.length) break;
			expect(page.length).toBeLessThanOrEqual(32);
			for (const job of page) complete.add(job.id);
			pages++;
		}
		expect(complete.size).toBe(360 + 4320 + 3 + 1);
		expect(pages).toBe(Math.ceil(4684 / 32));
		expect(() => planP7ShadowJobs(s, T0, new Set(), 65)).toThrow("SCHEDULE");
	});
	it("bootstrap is independent; after-fill precedes P7 daily and FINAL prefetch", () => {
		let s = init();
		expect(planP7ShadowJobs(s, T0, new Set()).map((j) => j.kind)).toEqual([
			"benchmark",
			"benchmark",
		]);
		s = {
			...s,
			benchmarks: {
				...s.benchmarks,
				products: {
					"BTC-USD": { ...s.benchmarks.products["BTC-USD"]!, phase: "failed" },
					"ETH-USD": { ...s.benchmarks.products["ETH-USD"]!, phase: "failed" },
				},
			},
			events: {
				...s.events,
				slots: {
					...s.events.slots,
					"fill-7": {
						...s.events.slots.FINAL!,
						markId: "fill-7",
						kind: "AFTER_FILL",
						expectedAt: T0,
						fillSequence: 7,
					},
				},
			},
		};
		expect(planP7ShadowJobs(s, T0, new Set())[0]?.id).toBe("fill-7");
		expect(
			planP7ShadowJobs(s, manifest.endAt - 4000, new Set(["fill-7"]))[0]?.id,
		).toBe("FINAL");
	});
	it("lost request suspends and clock cannot regress", () => {
		let s = init();
		s = applyP7Shadow(
			s,
			{ kind: "begin", command: { campaignId: "test", commandId: "begin" } },
			T0,
			2,
		);
		expect(s.campaign.phase).toBe("localObserving");
		expect(suspendP7ShadowForRequestGap(s, T0).campaign.phase).toBe(
			"suspended",
		);
		expect(() =>
			applyP7Shadow(
				s,
				{
					kind: "safety",
					command: { campaignId: "test", commandId: "safety" },
				},
				T0 - 1,
				3,
			),
		).toThrow("CLOCK");
		expect(() => planP7ShadowPricing(s, "BTC-USD", T0, T0)).toThrow(
			"QUOTE_NOT_PERSISTED",
		);
	});
});
it("rederives fills from immutable quote, rejects forged prices and 5s expiry", () => {
	let s = init(),
		seq = 2;
	const step = (
		event: import("./p7-prospective-ledger.js").P7LedgerCommand["event"],
		at = T0,
	) => {
		s = applyP7Shadow(
			s,
			{
				kind: "ledger",
				command: {
					campaignId: "test",
					commandId: `c${seq}`,
					productId: "BTC-USD",
					candleClosedAt: T0,
					event,
				},
			},
			at,
			seq++,
		);
	};
	s = applyP7Shadow(
		s,
		{ kind: "begin", command: { campaignId: "test", commandId: "begin" } },
		T0,
		seq++,
	);
	step({ type: "EXPECT" });
	step({ type: "ADMIT", evaluatedAt: T0, windowSha256: "a".repeat(64) });
	step({ type: "INTENT", side: "BUY", quantity: 1, portfolioVersion: 0 });
	step({ type: "REQUEST_QUOTE" });
	const book = {
		productId: "BTC-USD",
		sourceProfileId: "fixture",
		cacheStatus: "UNCACHED",
		requestedAt: T0,
		receivedAt: T0,
		sourceObservedAt: T0,
		sequence: "1",
		bids: [{ price: 99, quantity: 1000 }],
		asks: [{ price: 100, quantity: 1000 }],
	};
	step({ type: "OBSERVE_QUOTE", book, bodySha256: "b".repeat(64) });
	expect(planP7ShadowPricing(s, "BTC-USD", T0, T0 + 5000).ok).toBe(true);
	expect(planP7ShadowPricing(s, "BTC-USD", T0, T0 + 5001).ok).toBe(false);
	const price = 100 * 1.0002,
		fee = price * 0.006;
	expect(() =>
		step({
			type: "TERMINATE",
			outcome: { kind: "SIMULATED_FILL", price: 1, fee: 0.006 },
		}),
	).toThrow("CALLER_FILL_MISMATCH");
	expect(() =>
		step(
			{ type: "TERMINATE", outcome: { kind: "SIMULATED_FILL", price, fee } },
			T0 + 5001,
		),
	).toThrow("PRICING_REVALIDATION");
	step(
		{ type: "TERMINATE", outcome: { kind: "SIMULATED_FILL", price, fee } },
		T0 + 5000,
	);
	expect(s.ledger.portfolios["BTC-USD"].positionQuantity).toBe(1);
	expect(Object.keys(s.events.slots).some((k) => k.startsWith("fill-"))).toBe(
		true,
	);
	expect(() => step({ type: "EXPECT" }, T0 + 4999)).toThrow("CLOCK");
});
it("keeps suspended catchup bounded and does not schedule unknown benchmark requests again", () => {
	let s = init();
	s = applyP7Shadow(
		s,
		{ kind: "begin", command: { campaignId: "test", commandId: "begin" } },
		T0,
		2,
	);
	s = suspendP7ShadowForRequestGap(s, T0);
	const jobs = planP7ShadowJobs(s, T0, new Set());
	expect(jobs.every((j) => j.kind !== "benchmark")).toBe(true);
	expect(jobs.filter((j) => j.kind === "daily")).toHaveLength(2);
	const stopped = {
		...s,
		campaign: { ...s.campaign, phase: "invalid" as const },
	};
	expect(planP7ShadowJobs(stopped, T0, new Set())).toEqual([]);
});

it("explicitly preserves admitted and expired nonterminal recovery evidence", () => {
	let s = init();
	const command = (
		event: import("./p7-prospective-ledger.js").P7LedgerCommand["event"],
		id: string,
	) => ({
		kind: "ledger" as const,
		command: {
			campaignId: "test",
			commandId: id,
			productId: "BTC-USD" as const,
			candleClosedAt: T0,
			event,
		},
	});
	expect(planP7ShadowDailyRecovery(s, "BTC-USD", T0, T0)).toBe("RESUME");
	s = applyP7Shadow(
		s,
		{ kind: "begin", command: { campaignId: "test", commandId: "begin" } },
		T0,
		2,
	);
	s = applyP7Shadow(s, command({ type: "EXPECT" }, "expect"), T0, 3);
	expect(planP7ShadowDailyRecovery(s, "BTC-USD", T0, T0 + 7200001)).toBe(
		"MISSED",
	);
	s = applyP7Shadow(
		s,
		command(
			{ type: "ADMIT", evaluatedAt: T0, windowSha256: "a".repeat(64) },
			"admit",
		),
		T0,
		4,
	);
	expect(hasP7InterruptedAdmission(s)).toBe(true);
	const suspended = suspendP7ShadowForRequestGap(
		s,
		T0,
		"ADMITTED_DECISION_UNRESOLVED",
	);
	expect(planP7ShadowDailyRecovery(suspended, "BTC-USD", T0, T0)).toBe(
		"UNRESOLVED",
	);
	for (const phase of ["admitted", "intent", "requested", "quoted"] as const) {
		const state = {
			...s,
			ledger: {
				...s.ledger,
				slots: {
					...s.ledger.slots,
					[`BTC-USD:${T0}`]: { ...s.ledger.slots[`BTC-USD:${T0}`]!, phase },
				},
			},
		};
		expect(planP7ShadowDailyRecovery(state, "BTC-USD", T0, T0 + 7200001)).toBe(
			"UNRESOLVED",
		);
	}
	expect(suspended.ledger.slots[`BTC-USD:${T0}`]?.admission?.evaluatedAt).toBe(
		T0,
	);
	expect(suspended.ledger.slots[`BTC-USD:${T0}`]?.outcome).toBe(null);
});
