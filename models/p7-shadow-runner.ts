import {
	applyP7BenchmarkEntry,
	emptyP7BenchmarkEntries,
	type P7BenchmarkEntries,
} from "./p7-prospective-benchmark-entry.js";
import {
	type P7BenchmarkProfile,
	registerP7BenchmarkProfile,
} from "./p7-prospective-benchmarks.js";
import {
	applyP7LocalCampaignCommand,
	evaluateP7LocalCampaignSafety,
	initialP7LocalCampaign,
	type P7LocalCampaignState,
} from "./p7-prospective-campaign-safety.js";
import {
	applyP7EventMarkCommand,
	checkP7EventMarkClock,
	emptyP7EventMarks,
	expectP7AfterFill,
	hasP7AfterFillBlocker,
	type P7EventMarkState,
} from "./p7-prospective-event-marks.js";
import { applyP7JointMarkCommand } from "./p7-prospective-joint-marks.js";
import {
	applyP7LedgerCommand,
	initializeP7Ledger,
	type P7LedgerCommand,
	type P7LedgerManifest,
	type P7LedgerState,
} from "./p7-prospective-ledger.js";
import {
	emptyP7MarkState,
	evaluateP7MarkCommitClock,
	type P7MarkCommand,
	type P7MarkState,
} from "./p7-prospective-marks.js";
import { planP7Pricing } from "./p7-prospective-pricing.js";
import { evaluateP7PricingCommitClock } from "./p7-prospective-pricing-commit.js";
import {
	planTargetExposure,
	type TargetExposureCandle,
} from "./target-exposure.js";
export const P7_PRODUCTS = ["BTC-USD", "ETH-USD"] as const;
export type P7Product = (typeof P7_PRODUCTS)[number];
export const P7_DAY = 86_400_000,
	P7_HOUR = 3_600_000;
export interface P7ShadowProjection {
	ledger: P7LedgerState;
	campaign: P7LocalCampaignState;
	benchmarks: P7BenchmarkEntries;
	profile: P7BenchmarkProfile;
	marks: P7MarkState;
	benchmarkMarks: P7MarkState;
	events: P7EventMarkState;
	books: Record<string, unknown>;
	lastAt: number;
	hasFills: boolean;
}
function unwrap<T>(
	result: { ok: true; value: T } | { ok: false; error: string },
): T {
	if (!result.ok) throw new Error(result.error);
	return result.value;
}
export function initializeP7Shadow(
	manifest: P7LedgerManifest,
	profile: P7BenchmarkProfile,
	at: number,
): P7ShadowProjection {
	const ledger = unwrap(initializeP7Ledger(manifest, at));
	const checked = unwrap(
		registerP7BenchmarkProfile(
			null,
			manifest,
			{
				campaignId: manifest.campaignId,
				commandId: "profile",
				event: { type: "REGISTER_BENCHMARK_PROFILE", ...profile },
			},
			at,
		),
	);
	let benchmarks = emptyP7BenchmarkEntries();
	for (const productId of P7_PRODUCTS)
		benchmarks = unwrap(
			applyP7BenchmarkEntry(
				benchmarks,
				ledger,
				checked,
				"registered",
				{
					campaignId: manifest.campaignId,
					commandId: `expect-bh-${productId}`,
					productId,
					event: { type: "EXPECT_BENCHMARK" },
				},
				at,
			),
		).state;
	const marks = emptyP7MarkState(),
		benchmarkMarks = emptyP7MarkState();
	const events = unwrap(
		applyP7EventMarkCommand(
			emptyP7EventMarks(),
			ledger,
			benchmarks,
			marks,
			benchmarkMarks,
			true,
			false,
			{
				campaignId: manifest.campaignId,
				commandId: "event-marks",
				markId: "FINAL",
				event: { type: "REGISTER_EVENT_MARKS" },
			},
			at,
		),
	).state;
	return {
		ledger,
		profile: checked,
		campaign: initialP7LocalCampaign(at),
		benchmarks,
		marks,
		benchmarkMarks,
		events,
		books: {},
		lastAt: at,
		hasFills: false,
	};
}
export function p7ShadowSafety(
	s: P7ShadowProjection,
	at: number,
	recovery = false,
): P7LocalCampaignState {
	const pending =
		Object.values(s.benchmarks.products).some(
			(v) => v?.phase === "requested",
		) || Object.values(s.events.slots).some((v) => v.phase === "requested");
	return evaluateP7LocalCampaignSafety(
		s.campaign,
		s.ledger,
		s.marks,
		at,
		recovery,
		pending,
		s.benchmarkMarks,
		Object.values(s.events.slots).flatMap((v) =>
			v.observation ? [v.observation] : [],
		),
	);
}
export type P7ShadowCommand =
	| { kind: "ledger"; command: P7LedgerCommand }
	| {
			kind: "benchmark";
			command: {
				campaignId: string;
				commandId: string;
				productId: P7Product;
				event: { type: string; book?: unknown; bodySha256?: string };
			};
	  }
	| { kind: "mark"; command: P7MarkCommand }
	| {
			kind: "event";
			command: {
				campaignId: string;
				commandId: string;
				markId: string;
				event: { type: string; books?: unknown };
			};
	  }
	| {
			kind: "begin" | "safety" | "recover" | "stop";
			command: { campaignId: string; commandId: string };
	  };
/** Full validation at transaction time. No network, clock reads or storage. */
export function applyP7Shadow(
	s: P7ShadowProjection,
	input: P7ShadowCommand,
	at: number,
	sequence: number,
): P7ShadowProjection {
	if (!Number.isSafeInteger(at) || at < s.lastAt)
		throw new Error("INVALID_CLOCK");
	let next = { ...s, lastAt: at },
		fill = false;
	if (["begin", "safety", "recover", "stop"].includes(input.kind)) {
		const type = (
			{
				begin: "BEGIN_LOCAL_SIMULATION",
				safety: "CHECK_LOCAL_SAFETY",
				recover: "RECOVER_LOCAL",
				stop: "STOP_LOCAL",
			} as const
		)[input.kind as "begin" | "safety" | "recover" | "stop"];
		next.campaign = unwrap(
			applyP7LocalCampaignCommand(
				s.campaign,
				s.ledger,
				s.marks,
				{ ...input.command, event: { type } },
				at,
				Object.values(s.benchmarks.products).some(
					(v) => v?.phase === "requested",
				) || Object.values(s.events.slots).some((v) => v.phase === "requested"),
				s.benchmarkMarks,
				Object.values(s.events.slots).flatMap((v) =>
					v.observation ? [v.observation] : [],
				),
			),
		);
	} else if (input.kind === "ledger") {
		const c = input.command;
		if (
			["INTENT", "REQUEST_QUOTE"].includes(c.event.type) ||
			(c.event.type === "TERMINATE" &&
				c.event.outcome.kind === "SIMULATED_FILL")
		) {
			if (p7ShadowSafety(s, at).phase !== "localObserving")
				throw new Error("CAMPAIGN_SAFETY_BLOCKED");
			if (hasP7AfterFillBlocker(s.events))
				throw new Error("AFTER_FILL_MARK_REQUIRED");
		}
		if (
			c.event.type === "TERMINATE" &&
			c.event.outcome.kind === "SIMULATED_FILL"
		) {
			const pricing = planP7ShadowPricing(s, c.productId, c.candleClosedAt, at),
				intent = s.ledger.slots[`${c.productId}:${c.candleClosedAt}`]?.intent;
			if (!pricing.ok || !intent)
				throw new Error("PRICING_REVALIDATION_FAILED");
			const price =
					pricing.vwap * (1 + (intent.side === "BUY" ? 1 : -1) * 0.0002),
				fee = price * intent.quantity * 0.006;
			if (c.event.outcome.price !== price || c.event.outcome.fee !== fee)
				throw new Error("CALLER_FILL_MISMATCH");
		}
		const result = unwrap(applyP7LedgerCommand(s.ledger, c, at));
		next.ledger = result.state;
		if (c.event.type === "OBSERVE_QUOTE")
			next.books = {
				...s.books,
				[`${c.productId}:${c.candleClosedAt}`]: c.event.book,
			};
		fill =
			c.event.type === "TERMINATE" && c.event.outcome.kind === "SIMULATED_FILL";
		if (fill) {
			const book = s.books[`${c.productId}:${c.candleClosedAt}`] as
				| { sourceObservedAt?: number }
				| undefined;
			const error = evaluateP7PricingCommitClock({
				recordedAt: at,
				commitCheckedAt: at,
				sourceObservedAt: book?.sourceObservedAt,
				candleClosedAt: c.candleClosedAt,
				campaignEndAt: s.ledger.manifest.endAt,
				simulatedFill: true,
			});
			if (error) throw new Error(error);
		}
		if (c.event.type === "TERMINATE") {
			next.books = { ...next.books };
			delete next.books[`${c.productId}:${c.candleClosedAt}`];
		}
	} else if (input.kind === "benchmark") {
		const result = unwrap(
			applyP7BenchmarkEntry(
				s.benchmarks,
				s.ledger,
				s.profile,
				p7ShadowSafety(s, at).phase,
				input.command,
				at,
			),
		);
		next.benchmarks = result.state;
		fill =
			input.command.event.type === "RESOLVE_BENCHMARK" &&
			result.receipt.phase === "initialized";
	} else if (input.kind === "mark") {
		const result = unwrap(
			applyP7JointMarkCommand(
				s.marks,
				s.benchmarkMarks,
				s.ledger,
				s.benchmarks,
				input.command,
				at,
			),
		);
		const error = evaluateP7MarkCommitClock(
			input.command,
			result.receipt,
			s.ledger.manifest,
			at,
			at,
		);
		const bhError = evaluateP7MarkCommitClock(
			input.command,
			{ ...result.receipt, observation: result.receipt.benchmarkObservation },
			s.ledger.manifest,
			at,
			at,
		);
		if (error || bhError) throw new Error(error ?? bhError ?? "MARK_INVALID");
		next.marks = result.state;
		next.benchmarkMarks = result.benchmarkState;
	} else if (input.kind === "event") {
		const result = unwrap(
			applyP7EventMarkCommand(
				s.events,
				s.ledger,
				s.benchmarks,
				s.marks,
				s.benchmarkMarks,
				true,
				s.hasFills,
				input.command,
				at,
			),
		);
		const error = checkP7EventMarkClock(
			result.receipt,
			input.command.event.type === "OBSERVE_EVENT_MARK"
				? (input.command.event.books as never)
				: null,
			s.ledger.manifest.endAt,
			at,
			at,
		);
		if (error) throw new Error(error);
		next.events = result.state;
	}
	if (fill) {
		next.hasFills = true;
		next.events = expectP7AfterFill(next.events, sequence, at);
	}
	next.campaign = p7ShadowSafety(next, at);
	return next;
}
export function planP7ShadowPricing(
	s: P7ShadowProjection,
	product: P7Product,
	close: number,
	at: number,
) {
	const slot = s.ledger.slots[`${product}:${close}`];
	if (slot?.phase !== "quoted" || !slot.intent)
		throw new Error("QUOTE_NOT_PERSISTED");
	const price = planP7Pricing(
		{
			productId: product,
			sourceProfileId: s.ledger.manifest.sourceProfileId,
			clockVerified: s.ledger.manifest.clockVerified,
			campaignStartAt: s.ledger.manifest.startAt,
			campaignEndAt: s.ledger.manifest.endAt,
			candleClosedAt: close,
			intentPersistedAt: slot.intent.persistedAt,
			previousSequence: s.ledger.lastSequences[product],
		},
		s.books[`${product}:${close}`],
		slot.intent.side,
		slot.intent.quantity,
		at,
	);
	return price;
}
export function planP7ShadowDecision(
	s: P7ShadowProjection,
	product: P7Product,
	close: number,
	candles: unknown,
) {
	if (
		!Array.isArray(candles) ||
		candles.length !== 240 ||
		candles.some(
			(v, i) =>
				!v ||
				typeof v !== "object" ||
				Object.keys(v).sort().join(",") !== "close,start" ||
				v.start !== close - (240 - i) * P7_DAY ||
				!Number.isFinite(v.close) ||
				v.close <= 0,
		)
	)
		throw new Error("INVALID_DAILY_WINDOW");
	return planTargetExposure({
		candles: candles as TargetExposureCandle[],
		...s.ledger.portfolios[product],
		feeBps: 60,
		slippageBps: 2,
	});
}
export interface P7ShadowJob {
	id: string;
	kind: "benchmark" | "daily" | "hourly" | "event" | "assessment";
	product?: P7Product;
	at: number;
	markId?: string;
	checkpoint?: 30 | 90 | 180;
}
/** Bounded page, stable IDs. Missing past slots remain explicit; never replay journal. */
export function planP7ShadowJobs(
	s: P7ShadowProjection,
	now: number,
	completed: ReadonlySet<string>,
	limit = 32,
): P7ShadowJob[] {
	if (
		!Number.isSafeInteger(now) ||
		now < s.lastAt ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 64
	)
		throw new Error("INVALID_SCHEDULE");
	const jobs: P7ShadowJob[] = [],
		{ startAt, endAt } = s.ledger.manifest;
	const add = (job: P7ShadowJob) => {
		if (!completed.has(job.id) && jobs.length < limit) jobs.push(job);
	};
	const economic = !["suspended", "stopped", "invalid", "ended"].includes(
		s.campaign.phase,
	);
	if (s.campaign.phase === "invalid") {
		for (const checkpoint of [30, 90, 180] as const)
			if (now >= startAt + checkpoint * P7_DAY)
				add({
					id: `assessment-${checkpoint}`,
					kind: "assessment",
					checkpoint,
					at: startAt + checkpoint * P7_DAY,
				});
		return jobs;
	}
	// Bootstrap both legs before after-fill marks: model requires complete B&H pair.
	if (
		economic &&
		now >= startAt &&
		P7_PRODUCTS.some(
			(p) =>
				!["initialized", "failed"].includes(
					s.benchmarks.products[p]?.phase ?? "",
				),
		)
	) {
		for (const product of P7_PRODUCTS)
			if (
				!["initialized", "failed"].includes(
					s.benchmarks.products[product]?.phase ?? "",
				)
			)
				add({ id: `bh-${product}`, kind: "benchmark", product, at: startAt });
		return jobs;
	}
	for (const slot of Object.values(s.events.slots))
		if (economic && slot.kind === "AFTER_FILL" && slot.phase !== "observed")
			add({
				id: slot.markId,
				kind: "event",
				markId: slot.markId,
				at: slot.expectedAt,
			});
	if (jobs.length) return jobs;
	if (now >= endAt - 4_000 && s.events.slots.FINAL?.phase !== "observed")
		add({ id: "FINAL", kind: "event", markId: "FINAL", at: endAt });
	// Materialize daily before hourly catchup to preserve the complete denominator.
	for (
		let at = startAt;
		at <= now && at < endAt && jobs.length < limit;
		at += P7_DAY
	)
		for (const product of P7_PRODUCTS)
			add({ id: `daily-${product}-${at}`, kind: "daily", product, at });
	for (
		let at = startAt;
		at <= now && at < endAt && jobs.length < limit;
		at += P7_HOUR
	)
		add({ id: `hourly-${at}`, kind: "hourly", at });
	for (const checkpoint of [30, 90, 180] as const)
		if (now >= startAt + checkpoint * P7_DAY)
			add({
				id: `assessment-${checkpoint}`,
				kind: "assessment",
				checkpoint,
				at: startAt + checkpoint * P7_DAY,
			});
	return jobs;
}
export function suspendP7ShadowForRequestGap(
	s: P7ShadowProjection,
	at: number,
	reason = "RESPONSE_UNOBSERVED_AT_RECOVERY",
): P7ShadowProjection {
	const next = { ...s, lastAt: at, campaign: p7ShadowSafety(s, at, true) };
	if (next.campaign.phase === "localObserving")
		next.campaign = {
			...next.campaign,
			phase: "suspended",
			reasons: [...next.campaign.reasons, reason],
		};
	return next;
}
/** Commit-time check ignores display timestamps but never economic or safety changes. */
export function p7ShadowCommitSignature(s: P7ShadowProjection): unknown {
	return {
		phase: s.campaign.phase,
		portfolios: s.ledger.portfolios,
		benchmarks: P7_PRODUCTS.map((p) => ({
			phase: s.benchmarks.products[p]?.phase,
			portfolio: s.benchmarks.products[p]?.portfolio,
		})),
		marks: Object.keys(s.marks.slots)
			.sort()
			.map((k) => s.marks.slots[k]!)
			.map((v) => v.observation?.consolidated.available ?? null),
		benchmarkMarks: Object.keys(s.benchmarkMarks.slots)
			.sort()
			.map((k) => s.benchmarkMarks.slots[k]!)
			.map((v) => v.observation?.consolidated.available ?? null),
		events: Object.keys(s.events.slots)
			.sort()
			.map((k) => s.events.slots[k]!)
			.map((v) => [
				v.observation?.consolidated.available ?? null,
				v.benchmarkObservation?.consolidated.available ?? null,
			]),
	};
}
export function planP7ShadowDailyRecovery(
	s: P7ShadowProjection,
	product: P7Product,
	close: number,
	at: number,
): "DONE" | "MISSED" | "UNRESOLVED" | "RESUME" {
	const slot = s.ledger.slots[`${product}:${close}`];
	if (!slot) return "RESUME";
	if (slot.phase === "terminal") return "DONE";
	const expired = at > close + 7200000 || at >= s.ledger.manifest.endAt;
	if (slot.phase === "expected") return expired ? "MISSED" : "RESUME";
	if (
		expired ||
		["suspended", "stopped", "invalid", "ended"].includes(s.campaign.phase)
	)
		return "UNRESOLVED";
	return "RESUME";
}
export const hasP7InterruptedAdmission = (s: P7ShadowProjection): boolean =>
	Object.values(s.ledger.slots).some((slot) => slot.phase === "admitted");
