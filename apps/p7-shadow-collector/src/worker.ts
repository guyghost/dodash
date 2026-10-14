import { DurableObject } from "cloudflare:workers";
import type { ProductId } from "@dodash/domain";
import { executePaperOrder } from "@dodash/paper-execution";
import { checkRisk, type RiskConfig } from "@dodash/risk";
import { assessP7CampaignSnapshot } from "../../../models/p7-prospective-assessment.js";
import type { P7BenchmarkProfile } from "../../../models/p7-prospective-benchmarks.js";
import type {
	P7LedgerCommand,
	P7LedgerManifest,
} from "../../../models/p7-prospective-ledger.js";
import type { P7MarkEvidence } from "../../../models/p7-prospective-marks.js";
import {
	type P7ShadowPhase,
	transitionP7Shadow,
} from "../../../models/p7-shadow-lifecycle.js";
import {
	applyP7Shadow,
	initializeP7Shadow,
	P7_HOUR,
	P7_PRODUCTS,
	type P7Product,
	type P7ShadowCommand,
	type P7ShadowJob,
	type P7ShadowProjection,
	p7ShadowCommitSignature,
	p7ShadowSafety,
	planP7ShadowDecision,
	planP7ShadowJobs,
	planP7ShadowPricing,
	suspendP7ShadowForRequestGap,
} from "../../../models/p7-shadow-runner.js";
import {
	decisionCandlePnl,
	type TargetExposureCandle,
	targetExposureRiskGate,
} from "../../../models/target-exposure.js";
export interface Env {
	CAMPAIGNS: DurableObjectNamespace;
	ARCHIVE: R2Bucket;
	LOCAL_FIXTURES_ENABLED?: string;
	PROSPECTIVE_ENABLED?: string;
	FIXTURE_SOURCE?: Fetcher;
}
interface Registration {
	manifest: P7LedgerManifest;
	profile: P7BenchmarkProfile;
	risk: RiskConfig;
	codeSha256: string;
	protocolSha256: string;
	at: number;
}
const ZERO = "0".repeat(64);
export function canonical(v: unknown): string {
	if (v === null || typeof v === "string" || typeof v === "boolean")
		return JSON.stringify(v);
	if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (typeof v === "object" && v !== null)
		return `{${Object.keys(v)
			.sort()
			.map(
				(k) =>
					`${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
			)
			.join(",")}}`;
	throw new Error("INVALID_JSON");
}
async function hash(body: string): Promise<string> {
	return [
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
		),
	]
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("");
}
export class P7Campaign extends DurableObject<Env> {
	private serial: Promise<unknown> = Promise.resolve();
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS projection (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal (sequence INTEGER PRIMARY KEY, command_id TEXT UNIQUE NOT NULL, input TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, projection_hash TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT,'append-only'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT,'append-only'); END;
      CREATE TABLE IF NOT EXISTS outbox (sequence INTEGER PRIMARY KEY, object_key TEXT UNIQUE NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL, status TEXT NOT NULL, response TEXT);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoint_parts (checkpoint INTEGER NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(checkpoint,part));
      CREATE TABLE IF NOT EXISTS checkpoints (checkpoint INTEGER PRIMARY KEY, sequence INTEGER NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, body TEXT NOT NULL);`);
		ctx.blockConcurrencyWhile(async () => {
			await this.verifyJournal();
			const pending = this.rows(
					"SELECT id FROM requests WHERE status='REQUESTED'",
				),
				state = this.state();
			if (state && pending.length)
				await this.commit(
					`recovery-${this.head().sequence}`,
					{ pending },
					state.lastAt,
					(s) => suspendP7ShadowForRequestGap(s, s.lastAt),
				);
		});
	}
	private rows(
		q: string,
		...args: (string | number | null)[]
	): Record<string, SqlStorageValue>[] {
		return this.ctx.storage.sql.exec(q, ...args).toArray();
	}
	private state(): P7ShadowProjection | null {
		const rows = this.rows("SELECT body FROM projection ORDER BY id");
		return rows.length
			? JSON.parse(rows.map((r) => String(r.body)).join(""))
			: null;
	}
	private writeProjection(state: P7ShadowProjection): void {
		const body = canonical(state);
		this.ctx.storage.sql.exec("DELETE FROM projection");
		for (let offset = 0, id = 1; offset < body.length; offset += 131072, id++)
			this.ctx.storage.sql.exec(
				"INSERT INTO projection VALUES(?,?)",
				id,
				body.slice(offset, offset + 131072),
			);
	}
	private required(): P7ShadowProjection {
		const s = this.state();
		if (!s) throw new Error("NOT_REGISTERED");
		return s;
	}
	private head() {
		const r = this.rows(
			"SELECT sequence,hash FROM journal ORDER BY sequence DESC LIMIT 1",
		)[0];
		return r
			? { sequence: Number(r.sequence), hash: String(r.hash) }
			: { sequence: 0, hash: ZERO };
	}
	private registration(): Registration {
		const r = this.rows(
			"SELECT body FROM metadata WHERE key='registration'",
		)[0];
		if (!r) throw new Error("NOT_REGISTERED");
		return JSON.parse(String(r.body));
	}
	private async commit(
		id: string,
		input: unknown,
		at: number,
		reduce: (s: P7ShadowProjection, seq: number) => P7ShadowProjection,
		extra?: () => void,
	): Promise<void> {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id))
			throw new Error("INVALID_COMMAND_ID");
		const encoded = canonical(input),
			prior = this.rows("SELECT input FROM journal WHERE command_id=?", id)[0];
		if (prior) {
			if (prior.input !== encoded) throw new Error("COMMAND_ID_CONFLICT");
			return;
		}
		const before = this.required(),
			head = this.head(),
			sequence = head.sequence + 1;
		if (!Number.isSafeInteger(at) || at < before.lastAt)
			throw new Error("INVALID_CLOCK");
		const after = reduce(before, sequence),
			body = canonical({
				observation: "SYNTHETIC_LOCAL_PREPARATION",
				sequence,
				previousHash: head.hash,
				recordedAt: at,
				command:
					input && typeof input === "object" && "command" in input
						? (input as { command: unknown }).command
						: { commandId: id, effect: input },
			});
		const projectionHash = await hash(canonical(after));
		const digest = await hash(body),
			key = `p7-shadow/v1/${before.ledger.manifest.campaignId}/${String(sequence).padStart(8, "0")}-${digest}.json`;
		this.ctx.storage.transactionSync(() => {
			if (this.head().sequence !== head.sequence)
				throw new Error("CONCURRENT_REVISION");
			if (canonical(reduce(this.required(), sequence)) !== canonical(after))
				throw new Error("NONDETERMINISTIC_PROJECTION");
			for (const checkpoint of [30, 90, 180]) {
				const cutoff = before.ledger.manifest.startAt + checkpoint * 86400000;
				const existing = this.rows(
					"SELECT sequence FROM checkpoints WHERE checkpoint=?",
					checkpoint,
				)[0];
				if (
					at >= cutoff &&
					(!existing ||
						at === cutoff ||
						(checkpoint === 180 &&
							after.events.slots.FINAL?.phase === "observed" &&
							before.events.slots.FINAL?.phase !== "observed"))
				) {
					const include =
						at === cutoff ||
						(checkpoint === 180 &&
							after.events.slots.FINAL?.phase === "observed");
					const frozenBody = canonical(include ? after : before);
					this.ctx.storage.sql.exec(
						"INSERT OR REPLACE INTO checkpoints VALUES(?,?,?,?)",
						checkpoint,
						include ? sequence : head.sequence,
						include ? digest : head.hash,
						"{}",
					);
					this.ctx.storage.sql.exec(
						"DELETE FROM checkpoint_parts WHERE checkpoint=?",
						checkpoint,
					);
					for (
						let offset = 0, part = 0;
						offset < frozenBody.length;
						offset += 131072, part++
					)
						this.ctx.storage.sql.exec(
							"INSERT INTO checkpoint_parts VALUES(?,?,?)",
							checkpoint,
							part,
							frozenBody.slice(offset, offset + 131072),
						);
				}
			}
			this.ctx.storage.sql.exec(
				"INSERT INTO journal VALUES (?,?,?,?,?,?)",
				sequence,
				id,
				encoded,
				body,
				digest,
				projectionHash,
			);
			this.writeProjection(after);
			this.ctx.storage.sql.exec(
				"INSERT INTO outbox(sequence,object_key,body,hash) VALUES (?,?,?,?)",
				sequence,
				key,
				body,
				digest,
			);
			extra?.();
		});
	}
	private async model(input: P7ShadowCommand, at: number) {
		at = Math.max(at, this.now());
		const before = this.required(),
			sequence = this.head().sequence + 1;
		await this.commit(
			input.command.commandId,
			input,
			at,
			(s, seq) => applyP7Shadow(s, input, at, seq),
			() => {
				const fresh = applyP7Shadow(before, input, this.now(), sequence);
				if (
					canonical(p7ShadowCommitSignature(fresh)) !==
					canonical(p7ShadowCommitSignature(this.required()))
				)
					throw new Error("COMMIT_SAFETY_CHANGED");
			},
		);
	}
	private async register(r: Registration) {
		const body = canonical(r);
		if (this.state()) {
			if (canonical(this.registration()) !== body)
				throw new Error("MANIFEST_CONFLICT");
			return;
		}
		if (
			!r ||
			![r.codeSha256, r.protocolSha256].every(
				(v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
			)
		)
			throw new Error("CODE_PROTOCOL_SCOPE_REQUIRED");
		const state = initializeP7Shadow(r.manifest, r.profile, r.at);
		const risk = checkRisk(
			{
				clientOrderId: "config",
				decisionId: "config",
				strategyIds: ["P7"],
				productId: "BTC-USD" as ProductId,
				side: "BUY",
				type: "MARKET",
				quantity: 1,
				limitPrice: null,
			},
			{
				marketPrice: 1,
				currentPositionQuantity: 0,
				otherExposureNotional: 0,
				dailyPnl: 0,
				lastTradeAt: null,
				now: r.at,
				killSwitchActive: false,
			},
			r.risk,
		);
		if (!risk.ok) throw new Error("INVALID_RISK_CONFIG");
		const projectionHash = await hash(canonical(state));
		const entry = canonical({
				observation: "SYNTHETIC_LOCAL_PREPARATION",
				sequence: 1,
				previousHash: ZERO,
				recordedAt: r.at,
				manifest: r.manifest,
				registration: r,
			}),
			digest = await hash(entry);
		this.ctx.storage.transactionSync(() => {
			if (this.state()) throw new Error("REGISTRATION_CONFLICT");
			this.ctx.storage.sql.exec(
				"INSERT INTO metadata VALUES('lifecycle',?)",
				canonical({ phase: "registered" }),
			);
			this.writeProjection(state);
			this.ctx.storage.sql.exec(
				"INSERT INTO metadata VALUES('registration',?)",
				body,
			);
			this.ctx.storage.sql.exec(
				"INSERT INTO journal VALUES(1,'registration',?,?,?,?)",
				body,
				entry,
				digest,
				projectionHash,
			);
			this.ctx.storage.sql.exec(
				"INSERT INTO outbox(sequence,object_key,body,hash) VALUES(1,?,?,?)",
				`p7-shadow/v1/${r.manifest.campaignId}/00000001-${digest}.json`,
				entry,
				digest,
			);
		});
	}
	private async source(
		id: string,
		kind: "book" | "candles",
		product: P7Product,
		at: number,
		close?: number,
	): Promise<unknown> {
		const prior = this.rows(
			"SELECT status,response FROM requests WHERE id=?",
			id,
		)[0];
		if (prior) {
			if (prior.status !== "CAPTURED")
				throw new Error("RESPONSE_UNOBSERVED_AT_RECOVERY");
			return JSON.parse(String(prior.response));
		}
		if (this.env.LOCAL_FIXTURES_ENABLED !== "true" || !this.env.FIXTURE_SOURCE)
			throw new Error("SOURCE_DISABLED");
		const requestRecordedAt = this.now();
		await this.commit(
			`request-${id}`,
			{
				type: "REQUEST",
				id,
				kind,
				product,
				requestedAt: at,
				candleClosedAt: close ?? null,
			},
			requestRecordedAt,
			(s) => ({ ...s, lastAt: requestRecordedAt }),
			() => {
				this.ctx.storage.sql.exec(
					"INSERT INTO requests VALUES(?,?,'REQUESTED',NULL)",
					id,
					at,
				);
			},
		);
		let payload: unknown,
			raw: string | null = null;
		try {
			const response = await Promise.race([
				this.env.FIXTURE_SOURCE.fetch("https://fixture.invalid/market", {
					method: "POST",
					body: JSON.stringify({
						id,
						kind,
						productId: product,
						requestedAt: at,
						candleClosedAt: close ?? null,
						sourceProfileId: this.required().ledger.manifest.sourceProfileId,
					}),
					signal: AbortSignal.timeout(5000),
				}),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("SOURCE_TIMEOUT")), 5000),
				),
			]);
			if (!response.ok) throw new Error("SOURCE_UNAVAILABLE");
			const text = await response.text();
			raw = text;
			if (text.length > 2_000_000) throw new Error("SOURCE_TOO_LARGE");
			payload = JSON.parse(text);
		} catch {
			payload = null;
		}
		const encoded = canonical(payload);
		const capturedAt = this.now();
		await this.commit(
			`capture-${id}`,
			{
				type: "CAPTURE",
				id,
				payload,
				raw,
				rawSha256: raw === null ? null : await hash(raw),
				bodySha256: await hash(encoded),
			},
			capturedAt,
			(s) => ({ ...s, lastAt: capturedAt }),
			() => {
				this.ctx.storage.sql.exec(
					"UPDATE requests SET status='CAPTURED',response=? WHERE id=? AND status='REQUESTED'",
					encoded,
					id,
				);
			},
		);
		return payload;
	}
	private async books(id: string, at: number) {
		const books = {} as Record<P7Product, P7MarkEvidence | null>;
		for (const p of P7_PRODUCTS) {
			const book = await this.source(`${id}-${p}`, "book", p, at);
			books[p] = { book, bodySha256: await hash(canonical(book)) };
		}
		return books;
	}
	private async done(job: P7ShadowJob, at: number, result: unknown = null) {
		at = Math.max(at, this.now());
		await this.commit(
			`done-${job.id}`,
			{ type: "JOB_COMPLETED", job, result },
			at,
			(s) => ({ ...s, lastAt: at }),
			() => {
				this.ctx.storage.sql.exec(
					"INSERT OR REPLACE INTO jobs VALUES(?,?)",
					job.id,
					canonical({ at, result }),
				);
			},
		);
	}
	private completed(at: number): Set<string> {
		return new Set(
			this.rows(
				"SELECT id FROM jobs WHERE json_extract(body,'$.retryAt') IS NULL OR json_extract(body,'$.retryAt')>?",
				at,
			).map((r) => String(r.id)),
		);
	}
	private async defer(job: P7ShadowJob, at: number, retryAt: number) {
		at = this.now();
		await this.commit(
			`defer-${job.id}`,
			{ type: "WAIT_DEADLINE", job, retryAt },
			at,
			(s) => ({ ...s, lastAt: at }),
			() => {
				this.ctx.storage.sql.exec(
					"INSERT OR REPLACE INTO jobs VALUES(?,?)",
					job.id,
					canonical({ retryAt }),
				);
			},
		);
	}
	private async runJob(job: P7ShadowJob, at: number): Promise<void> {
		let s = this.required();
		const campaignId = s.ledger.manifest.campaignId;
		if (job.kind === "benchmark") {
			const productId = job.product as P7Product;
			const command = (type: string, event: Record<string, unknown> = {}) => ({
				kind: "benchmark" as const,
				command: {
					campaignId,
					commandId: `${job.id}-${type}`,
					productId,
					event: { type, ...event },
				},
			});
			if (at > s.ledger.manifest.startAt + 7_200_000) {
				await this.model(command("EXPIRE_BENCHMARK"), at);
				await this.done(job, at);
				return;
			}
			if (s.benchmarks.products[productId]?.phase === "expected")
				await this.model(command("REQUEST_BENCHMARK"), at);
			s = this.required();
			if (s.benchmarks.products[productId]?.phase === "requested") {
				const book = await this.source(
					job.id,
					"book",
					productId,
					s.benchmarks.products[productId]?.requestedAt ?? at,
				);
				await this.model(
					command("OBSERVE_BENCHMARK_BOOK", {
						book,
						bodySha256: await hash(canonical(book)),
					}),
					at,
				);
			}
			if (this.required().benchmarks.products[productId]?.phase === "quoted")
				await this.model(command("RESOLVE_BENCHMARK"), at);
			if (
				this.required().benchmarks.products[productId]?.phase === "rejected"
			) {
				await this.defer(job, at, s.ledger.manifest.startAt + 7200001);
				return;
			}
			await this.done(job, at);
			return;
		}
		if (job.kind === "event") {
			const markId = job.markId as string,
				slot = s.events.slots[markId];
			if (!slot) throw new Error("EVENT_SLOT_MISSING");
			if (at >= s.ledger.manifest.endAt && slot.phase === "expected") {
				await this.done(job, at, { unavailable: "FINAL_REQUEST_MISSING" });
				return;
			}
			if (
				markId === "FINAL" &&
				at >= s.ledger.manifest.endAt &&
				this.rows(
					"SELECT id FROM requests WHERE id LIKE 'FINAL-%' AND status='REQUESTED' LIMIT 1",
				).length
			) {
				await this.done(job, at, { unavailable: "FINAL_RESPONSE_UNOBSERVED" });
				return;
			}
			if (slot.phase === "expected")
				await this.model(
					{
						kind: "event",
						command: {
							campaignId,
							commandId: `${job.id}-request`,
							markId,
							event: { type: "REQUEST_EVENT_MARK" },
						},
					},
					at,
				);
			const books = await this.books(
				job.id,
				this.required().events.slots[markId]?.requestedAt ?? at,
			);
			if (markId === "FINAL" && at < s.ledger.manifest.endAt) return;
			await this.model(
				{
					kind: "event",
					command: {
						campaignId,
						commandId: `${job.id}-observe`,
						markId,
						event: { type: "OBSERVE_EVENT_MARK", books },
					},
				},
				at,
			);
			await this.done(job, at);
			return;
		}
		if (job.kind === "hourly") {
			const command = (
				event:
					| { type: "EXPECT_MARK" | "REQUEST_MARK" }
					| {
							type: "OBSERVE_MARK";
							books: Record<P7Product, P7MarkEvidence | null>;
					  },
			) => ({
				kind: "mark" as const,
				command: {
					campaignId,
					commandId: `${job.id}-${event.type}`,
					scheduledAt: job.at,
					event,
				},
			});
			if (!s.marks.slots[String(job.at)])
				await this.model(command({ type: "EXPECT_MARK" }), at);
			if (at >= job.at + P7_HOUR) {
				await this.done(job, at, { unavailable: "MISSED_MARK_WINDOW" });
				return;
			}
			if (this.required().marks.slots[String(job.at)]?.phase === "expected")
				await this.model(command({ type: "REQUEST_MARK" }), at);
			await this.model(
				command({
					type: "OBSERVE_MARK",
					books: await this.books(
						job.id,
						this.required().marks.slots[String(job.at)]?.requestedAt ?? at,
					),
				}),
				at,
			);
			await this.done(job, at);
			return;
		}
		if (job.kind === "assessment") {
			const frozen = this.rows(
				"SELECT sequence,hash,body FROM checkpoints WHERE checkpoint=?",
				job.checkpoint ?? 180,
			)[0];
			if (!frozen) throw new Error("CHECKPOINT_NOT_FROZEN");
			const frozenBody = this.rows(
				"SELECT body FROM checkpoint_parts WHERE checkpoint=? ORDER BY part",
				job.checkpoint ?? 180,
			)
				.map((r) => String(r.body))
				.join("");
			const anchor = this.rows(
				"SELECT projection_hash,hash FROM journal WHERE sequence=?",
				Number(frozen.sequence),
			)[0];
			if (
				!anchor ||
				anchor.hash !== frozen.hash ||
				anchor.projection_hash !== (await hash(frozenBody))
			)
				throw new Error("CHECKPOINT_CORRUPT");
			s = JSON.parse(frozenBody);
			const entries = this.rows(
				"SELECT body FROM journal WHERE sequence<=? ORDER BY sequence",
				Number(frozen.sequence),
			).map((r) => JSON.parse(String(r.body)));
			const result = assessP7CampaignSnapshot(
				{
					observation: "SYNTHETIC_LOCAL_PREPARATION",
					state: s.ledger,
					markState: s.marks,
					benchmarkMarkState: s.benchmarkMarks,
					benchmarkEntries: s.benchmarks,
					eventMarkState: s.events,
					campaignState: s.campaign,
					jointMode: true,
					entries,
				},
				job.checkpoint as 30 | 90 | 180,
			);
			await this.done(job, at, {
				...result,
				checkpointSequence: Number(frozen.sequence),
				checkpointHash: String(frozen.hash),
			});
			return;
		}
		await this.daily(job, at);
	}
	private async daily(job: P7ShadowJob, at: number) {
		let s = this.required();
		const campaignId = s.ledger.manifest.campaignId,
			productId = job.product as P7Product,
			candleClosedAt = job.at,
			key = `${productId}:${candleClosedAt}`;
		const command = (event: P7LedgerCommand["event"]): P7ShadowCommand => ({
			kind: "ledger",
			command: {
				campaignId,
				commandId: `${job.id}-${event.type}`,
				productId,
				candleClosedAt,
				event,
			},
		});
		if (!s.ledger.slots[key]) await this.model(command({ type: "EXPECT" }), at);
		s = this.required();
		if (
			at > candleClosedAt + 7_200_000 &&
			s.ledger.slots[key]?.phase === "expected"
		) {
			await this.model(
				command({ type: "TERMINATE", outcome: { kind: "MISSED" } }),
				at,
			);
			await this.done(job, at);
			return;
		}
		at = this.now();
		if (p7ShadowSafety(s, at).phase !== "localObserving") {
			await this.defer(job, at, candleClosedAt + 7200001);
			return;
		}
		if (s.ledger.slots[key]?.phase === "expected") {
			const candles = await this.source(
				`${job.id}-candles`,
				"candles",
				productId,
				at,
				candleClosedAt,
			);
			let decision: ReturnType<typeof planP7ShadowDecision>;
			try {
				decision = planP7ShadowDecision(s, productId, candleClosedAt, candles);
			} catch {
				await this.defer(job, at, candleClosedAt + 7200001);
				return;
			}
			await this.model(
				command({
					type: "ADMIT",
					evaluatedAt: at,
					windowSha256: await hash(canonical(candles)),
				}),
				at,
			);
			if (decision.side === "HOLD") {
				await this.model(
					command({
						type: "TERMINATE",
						outcome: { kind: "HOLD", reason: decision.reason },
					}),
					at,
				);
				await this.done(job, at);
				return;
			}
			const portfolio = s.ledger.portfolios[productId],
				window = candles as TargetExposureCandle[],
				price = window.at(-1)?.close ?? 0;
			const gate = targetExposureRiskGate(
				decision.side,
				0,
				decisionCandlePnl(window, portfolio.positionQuantity),
			);
			const risk = checkRisk(
				{
					clientOrderId: job.id,
					decisionId: job.id,
					strategyIds: ["P7"],
					productId: productId as ProductId,
					side: decision.side,
					type: "MARKET",
					quantity: decision.quantity,
					limitPrice: null,
				},
				{
					marketPrice: price,
					currentPositionQuantity: portfolio.positionQuantity,
					otherExposureNotional: 0,
					dailyPnl: gate.dailyPnlForRisk,
					lastTradeAt: null,
					now: at,
					killSwitchActive: false,
				},
				this.registration().risk,
			);
			if (!risk.ok || risk.value.status !== "APPROVED") {
				await this.model(
					command({
						type: "TERMINATE",
						outcome: {
							kind: "RISK_REJECTED",
							reason:
								risk.ok && risk.value.status === "REJECTED"
									? risk.value.reasonCode
									: "INVALID_RISK",
						},
					}),
					at,
				);
				await this.done(job, at);
				return;
			}
			await this.model(
				command({
					type: "INTENT",
					side: decision.side,
					quantity: decision.quantity,
					portfolioVersion: portfolio.version,
				}),
				at,
			);
		}
		s = this.required();
		if (s.ledger.slots[key]?.phase === "intent")
			await this.model(command({ type: "REQUEST_QUOTE" }), at);
		s = this.required();
		if (s.ledger.slots[key]?.phase === "requested") {
			const book = await this.source(
				`${job.id}-quote`,
				"book",
				productId,
				s.ledger.slots[key]?.requestedAt ?? at,
			);
			await this.model(
				command({
					type: "OBSERVE_QUOTE",
					book,
					bodySha256: await hash(canonical(book)),
				}),
				at,
			);
		}
		s = this.required();
		if (s.ledger.slots[key]?.phase === "quoted") {
			const pricing = planP7ShadowPricing(
					s,
					productId,
					candleClosedAt,
					this.now(),
				),
				intent = s.ledger.slots[key]?.intent;
			if (!intent) throw new Error("INTENT_MISSING");
			if (!pricing.ok)
				await this.model(
					command({
						type: "TERMINATE",
						outcome: { kind: "QUOTE_REJECTED", reason: pricing.reason },
					}),
					at,
				);
			else {
				const result = executePaperOrder(
					{ ...s.ledger.portfolios[productId], averagePrice: 0 },
					{
						clientOrderId: job.id,
						decisionId: job.id,
						strategyIds: ["P7"],
						productId: productId as ProductId,
						side: intent.side,
						type: "MARKET",
						quantity: intent.quantity,
						limitPrice: null,
					},
					pricing.vwap,
					at,
					{ feeBps: 60, slippageBps: 2 },
				);
				await this.model(
					command({
						type: "TERMINATE",
						outcome: result.ok
							? {
									kind: "SIMULATED_FILL",
									price: result.value.trade.fill.price,
									fee: result.value.trade.fill.fee,
								}
							: { kind: "BROKER_REJECTED", reason: result.error.code },
					}),
					at,
				);
			}
		}
		await this.done(job, at);
	}
	private async wake(at: number, automatic = false) {
		const s = this.required(),
			campaignId = s.ledger.manifest.campaignId;
		if (!Number.isSafeInteger(at) || at < s.lastAt - 60_000)
			throw new Error("INVALID_CLOCK");
		const previousClock = this.rows(
			"SELECT body FROM metadata WHERE key='clock'",
		)[0];
		if (
			!automatic &&
			previousClock &&
			at < JSON.parse(String(previousClock.body)).requestedAt
		)
			throw new Error("INVALID_CLOCK");
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO metadata VALUES('clock',?)",
			canonical({
				virtualAt: Math.max(at, s.lastAt),
				requestedAt:
					automatic && previousClock
						? JSON.parse(String(previousClock.body)).requestedAt
						: at,
				wallAt: Date.now(),
			}),
		);
		at = this.now();
		if (at < s.ledger.manifest.startAt) {
			await this.schedule();
			return;
		}
		if (s.campaign.boundAt === null && at < s.ledger.manifest.endAt)
			await this.model(
				{ kind: "begin", command: { campaignId, commandId: "begin-local" } },
				at,
			);
		await this.model(
			{ kind: "safety", command: { campaignId, commandId: `safety-${at}` } },
			at,
		);
		for (let budget = 0; budget < 32; budget++) {
			at = this.now();
			const state = this.required();
			const completed = this.completed(at),
				job = planP7ShadowJobs(state, at, completed, 1)[0];
			if (!job) break;
			await this.runJob(job, at);
			if (job.id === "FINAL" && at < state.ledger.manifest.endAt) break;
		}
		await this.exportPage();
		await this.schedule();
	}
	private async exportPage() {
		const rows = this.rows(
			"SELECT sequence,object_key,body,hash FROM outbox WHERE acknowledged=0 ORDER BY sequence LIMIT 64",
		);
		for (const r of rows) {
			if ((await hash(String(r.body))) !== r.hash)
				throw new Error("EXPORT_HASH_MISMATCH");
			const journal = this.rows(
				"SELECT hash,body FROM journal WHERE sequence=?",
				Number(r.sequence),
			)[0];
			if (!journal || journal.hash !== r.hash || journal.body !== r.body)
				throw new Error("EXPORT_JOURNAL_MISMATCH");
			await this.env.ARCHIVE.put(String(r.object_key), String(r.body), {
				httpMetadata: { contentType: "application/json" },
				customMetadata: {
					sha256: String(r.hash),
					observation: "SYNTHETIC_LOCAL_PREPARATION",
				},
			});
			this.ctx.storage.sql.exec(
				"UPDATE outbox SET acknowledged=1 WHERE sequence=?",
				Number(r.sequence),
			);
		}
		return rows.length;
	}
	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.serial.then(fn);
		this.serial = result.catch(() => undefined);
		return result;
	}
	private now(): number {
		const row = this.rows("SELECT body FROM metadata WHERE key='clock'")[0];
		if (!row) return this.required().lastAt;
		const clock = JSON.parse(String(row.body));
		return Math.max(
			this.required().lastAt,
			clock.virtualAt + Math.max(0, Date.now() - clock.wallAt),
		);
	}
	private async schedule(): Promise<void> {
		const s = this.required(),
			now = this.now();
		const complete = this.completed(now);
		const pending = planP7ShadowJobs(s, now, complete, 1)[0];
		const immediate =
			pending && !(pending.id === "FINAL" && now < s.ledger.manifest.endAt);
		const deferred = Number(
			this.rows(
				"SELECT MIN(json_extract(body,'$.retryAt')) AS at FROM jobs WHERE json_extract(body,'$.retryAt')>?",
				now,
			)[0]?.at ?? Infinity,
		);
		const next = immediate
			? now + 100
			: Math.min(
					deferred,
					s.ledger.manifest.endAt,
					s.ledger.manifest.endAt - 4000 > now
						? s.ledger.manifest.endAt - 4000
						: Infinity,
					now < s.ledger.manifest.startAt
						? s.ledger.manifest.startAt
						: (Math.floor(now / P7_HOUR) + 1) * P7_HOUR,
				);
		if (next > now && (now < s.ledger.manifest.endAt || immediate)) {
			this.ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO metadata VALUES('next-wake',?)",
				String(next),
			);
			await this.ctx.storage.setAlarm(Date.now() + Math.max(25, next - now));
		} else if (
			this.rows("SELECT sequence FROM outbox WHERE acknowledged=0 LIMIT 1")
				.length
		)
			await this.ctx.storage.setAlarm(Date.now() + 100);
	}
	private async verifyJournal(): Promise<void> {
		let previous = ZERO,
			sequence = 0,
			projectionHash: string | null = null;
		for (const row of this.rows(
			"SELECT sequence,hash,body,projection_hash FROM journal ORDER BY sequence",
		)) {
			const body = JSON.parse(String(row.body));
			if (
				Number(row.sequence) !== ++sequence ||
				body.previousHash !== previous ||
				(await hash(String(row.body))) !== row.hash
			)
				throw new Error("JOURNAL_CORRUPT");
			previous = String(row.hash);
			projectionHash = String(row.projection_hash);
		}
		const state = this.state();
		if (state && (await hash(canonical(state))) !== projectionHash)
			throw new Error("PROJECTION_CORRUPT");
	}
	override async alarm(): Promise<void> {
		await this.enqueue(async () => {
			try {
				if (this.state()) {
					if (this.rows("SELECT body FROM metadata WHERE key='clock'").length)
						await this.wake(this.now(), true);
					else await this.exportPage();
				}
			} catch (error) {
				await this.ctx.storage.setAlarm(Date.now() + 60_000);
				throw error;
			}
		});
	}
	override async fetch(request: Request): Promise<Response> {
		return this.enqueue(async () => {
			try {
				const url = new URL(request.url);
				if (url.pathname.endsWith("/start"))
					throw new Error("PROSPECTIVE_ACTIVATION_DISABLED");
				if (
					this.env.LOCAL_FIXTURES_ENABLED !== "true" ||
					!this.env.FIXTURE_SOURCE
				)
					throw new Error("LOCAL_PREPARATION_DISABLED");
				if (request.method === "GET" && url.pathname.endsWith("/status"))
					return Response.json({
						observation: "SYNTHETIC_LOCAL_PREPARATION",
						prospectivePhase: JSON.parse(
							String(
								this.rows("SELECT body FROM metadata WHERE key='lifecycle'")[0]
									?.body ?? "{}",
							),
						).phase,
						state: this.state(),
						sequence: this.head().sequence,
						pendingExports: Number(
							this.rows(
								"SELECT COUNT(*) AS n FROM outbox WHERE acknowledged=0",
							)[0]?.n,
						),
						jobs: this.rows("SELECT id,body FROM jobs"),
					});
				if (request.method !== "POST")
					return new Response("Method not allowed", { status: 405 });
				const text = await request.text();
				if (text.length > 2_000_000) throw new Error("COMMAND_TOO_LARGE");
				const payload = JSON.parse(text);
				if (url.pathname.endsWith("/register")) {
					if (payload.manifest?.campaignId !== url.pathname.split("/")[2])
						throw new Error("CAMPAIGN_ID_MISMATCH");
					await this.register(payload as Registration);
				} else if (url.pathname.endsWith("/preflight")) {
					const r = this.registration(),
						phase = JSON.parse(
							String(
								this.rows("SELECT body FROM metadata WHERE key='lifecycle'")[0]
									?.body,
							),
						).phase as P7ShadowPhase;
					const next = transitionP7Shadow(
						phase,
						"PREFLIGHT",
						{
							purpose: "LOCAL_PREPARATION",
							campaignId: r.manifest.campaignId,
							sourceProfileId: r.manifest.sourceProfileId,
							codeSha256: r.codeSha256,
							protocolSha256: r.protocolSha256,
							registeredAt: r.at,
							startAt: r.manifest.startAt,
							endAt: r.manifest.endAt,
							qualifiedSource: false,
							operatorAuthority: null,
						},
						r.at,
						{
							enabled: false,
							qualifiedEvidence: false,
							operatorAuthority: null,
						},
					);
					await this.commit(
						"preflight",
						{ type: "PREFLIGHT" },
						this.required().lastAt,
						(s) => s,
						() => {
							this.ctx.storage.sql.exec(
								"UPDATE metadata SET body=? WHERE key='lifecycle'",
								canonical({ phase: next }),
							);
						},
					);
				} else if (url.pathname.endsWith("/wake")) await this.wake(payload.at);
				else if (url.pathname.endsWith("/assess")) {
					const checkpoint = payload.checkpoint;
					if (![30, 90, 180].includes(checkpoint))
						throw new Error("INVALID_CHECKPOINT");
					const at =
						this.required().ledger.manifest.startAt + checkpoint * 86400000;
					if (this.now() < at) throw new Error("CHECKPOINT_NOT_DUE");
					if (
						checkpoint === 180 &&
						this.required().events.slots.FINAL?.phase !== "observed" &&
						!this.rows("SELECT id FROM jobs WHERE id='FINAL'").length
					)
						throw new Error("FINAL_MARK_PENDING");
					await this.runJob(
						{
							id: `assessment-${checkpoint}`,
							kind: "assessment",
							checkpoint,
							at,
						},
						this.now(),
					);
					return Response.json(
						JSON.parse(
							String(
								this.rows(
									"SELECT body FROM jobs WHERE id=?",
									`assessment-${checkpoint}`,
								)[0]?.body,
							),
						),
					);
				} else if (url.pathname.endsWith("/export")) await this.exportPage();
				else if (url.pathname.endsWith("/alarm"))
					await this.ctx.storage.setAlarm(Date.now() + 25);
				else if (url.pathname.endsWith("/stop"))
					await this.model(
						{
							kind: "stop",
							command: {
								campaignId: this.required().ledger.manifest.campaignId,
								commandId: `stop-${payload.at}`,
							},
						},
						payload.at,
					);
				else return new Response("Not found", { status: 404 });
				if (
					this.rows("SELECT sequence FROM outbox WHERE acknowledged=0 LIMIT 1")
						.length
				)
					await this.ctx.storage.setAlarm(Date.now() + 100);
				return Response.json({ ok: true, sequence: this.head().sequence });
			} catch (error) {
				if (this.state()) await this.ctx.storage.setAlarm(Date.now() + 1000);
				return Response.json(
					{
						ok: false,
						error: error instanceof Error ? error.message : "FAILED",
					},
					{ status: 409 },
				);
			}
		});
	}
}
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const match =
			/^\/campaigns\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\/(register|preflight|wake|status|assess|export|alarm|stop|start)$/.exec(
				new URL(request.url).pathname,
			);
		if (!match?.[1]) return new Response("Not found", { status: 404 });
		return env.CAMPAIGNS.get(env.CAMPAIGNS.idFromName(match[1])).fetch(request);
	},
};
