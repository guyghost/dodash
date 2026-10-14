import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

await build({
	entryPoints: ["src/worker.ts"],
	outfile: "dist/worker.js",
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2023",
	external: ["cloudflare:workers"],
});
const DAY = 86400000,
	T0 = Date.UTC(2026, 10, 1);
const registration = (id = "test") => ({
	at: T0 - 1000,
	manifest: {
		purpose: "LOCAL_PREPARATION",
		campaignId: id,
		manifestSha256: "a".repeat(64),
		startAt: T0,
		endAt: T0 + 180 * DAY,
		sourceProfileId: "fixture",
		clockVerified: true,
	},
	profile: {
		sourceProfileId: "fixture",
		profileSha256: "b".repeat(64),
		quantityDecimals: { "BTC-USD": 8, "ETH-USD": 8 },
	},
	codeSha256: "c".repeat(64),
	protocolSha256: "d".repeat(64),
	risk: {
		maxOrderNotional: 1e9,
		maxPositionNotional: 1e9,
		maxGrossExposure: 1e9,
		maxDailyLoss: 1000,
		cooldownMs: 0,
		stopLossBps: 500,
		takeProfitBps: 1000,
	},
});
const fixture = async (request) => {
	const p = await request.json();
	if (p.kind === "candles")
		return Response.json(
			Array.from({ length: 240 }, (_, i) => ({
				start: p.candleClosedAt - (240 - i) * DAY,
				close: 1000 - i + (i % 2),
			})),
		);
	return Response.json({
		productId: p.productId,
		sourceProfileId: p.sourceProfileId,
		cacheStatus: "UNCACHED",
		sequence: String(p.requestedAt),
		requestedAt: p.requestedAt,
		receivedAt: p.requestedAt,
		sourceObservedAt: p.requestedAt,
		bids: [{ price: 99, quantity: 10000 }],
		asks: [{ price: 100, quantity: 10000 }],
	});
};
function runtime(path, source = fixture, enabled = true) {
	return new Miniflare({
		...convertV4MiniflareOptions({
			name: "collector",
			modules: true,
			scriptPath: "dist/worker.js",
			compatibilityDate: "2026-08-20",
			resourcePersistencePath: path,
			durableObjects: {
				CAMPAIGNS: { className: "P7Campaign", useSQLite: true },
			},
			r2Buckets: ["ARCHIVE"],
			bindings: { LOCAL_FIXTURES_ENABLED: String(enabled) },
			serviceBindings: { FIXTURE_SOURCE: source },
			outboundService: () => {
				throw new Error("EXTERNAL_NETWORK_FORBIDDEN");
			},
		}),
		unsafeInspectDurableObjects: true,
	});
}
async function call(mf, action, body = {}, id = "test") {
	const r = await mf.dispatchFetch(
		`http://localhost/campaigns/${id}/${action}`,
		{
			method: action === "status" ? "GET" : "POST",
			...(action === "status" ? {} : { body: JSON.stringify(body) }),
		},
	);
	return { status: r.status, body: await r.json() };
}
async function ok(mf, action, body = {}, id = "test") {
	const r = await call(mf, action, body, id);
	assert.equal(r.status, 200, JSON.stringify(r.body));
	return r.body;
}
test("real workerd SQLite/R2 HOLD independent B&H, marks, duplicate wake, restart", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	let mf = runtime(path);
	try {
		await ok(mf, "register", registration());
		await ok(mf, "wake", { at: T0 });
		let s = await ok(mf, "status");
		assert.equal(s.state.benchmarks.products["BTC-USD"].phase, "initialized");
		assert.equal(s.state.benchmarks.products["ETH-USD"].phase, "initialized");
		assert.equal(s.state.ledger.slots[`BTC-USD:${T0}`].outcome.kind, "HOLD");
		assert.equal(
			s.state.marks.slots[T0].observation.consolidated.available,
			true,
		);
		assert.equal(
			s.state.benchmarkMarks.slots[T0].observation.consolidated.available,
			true,
		);
		await ok(mf, "wake", { at: T0 });
		s = await ok(mf, "status");
		const seq = s.sequence;
		assert.equal(Object.keys(s.state.ledger.slots).length, 2);
		assert.equal(s.state.ledger.portfolios["BTC-USD"].version, 1);
		const bucket = await mf.getR2Bucket("ARCHIVE");
		assert.ok((await bucket.list()).objects.length > 0);
		await mf.dispose();
		mf = runtime(path);
		s = await ok(mf, "status");
		assert.equal(s.sequence, seq);
		assert.equal(s.state.campaign.phase, "localObserving");
		await ok(mf, "wake", { at: T0 + 3600000 });
		assert.equal(
			(await ok(mf, "status")).state.marks.slots[T0 + 3600000].phase,
			"observed",
		);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("real activation disabled, local fixtures require capability", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	const mf = runtime(path, fixture, false);
	try {
		assert.equal(
			(await call(mf, "register", registration())).body.error,
			"LOCAL_PREPARATION_DISABLED",
		);
		assert.equal(
			(await call(mf, "start", {})).body.error,
			"PROSPECTIVE_ACTIVATION_DISABLED",
		);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("actual alarm drains retry after R2 put succeeded but acknowledgement failed", async () => {
	await build({
		entryPoints: ["test/fault-worker.ts"],
		outfile: "dist/fault-worker.js",
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2023",
		external: ["cloudflare:workers"],
	});
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	const opts = (fail) =>
		convertV4MiniflareOptions({
			name: "collector",
			modules: true,
			scriptPath: "dist/fault-worker.js",
			compatibilityDate: "2026-08-20",
			resourcePersistencePath: path,
			durableObjects: {
				CAMPAIGNS: { className: "FaultCampaign", useSQLite: true },
			},
			r2Buckets: ["ARCHIVE"],
			bindings: { LOCAL_FIXTURES_ENABLED: "true", FAIL_EXPORT: fail },
			serviceBindings: { FIXTURE_SOURCE: fixture },
		});
	let mf = new Miniflare(opts("after-put"));
	try {
		await ok(mf, "register", registration());
		const failed = await call(mf, "export");
		assert.match(failed.body.error, /ACK_FAILURE/);
		assert.equal((await ok(mf, "status")).pendingExports, 1);
		const bucket = await mf.getR2Bucket("ARCHIVE");
		const first = (await bucket.list()).objects;
		assert.equal(first.length, 1);
		const firstKey = first[0].key;
		const body = await (await bucket.get(firstKey)).text();
		await mf.dispose();
		mf = new Miniflare(opts(""));
		await ok(mf, "alarm");
		for (let i = 0; i < 50; i++) {
			if ((await ok(mf, "status")).pendingExports === 0) break;
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.equal((await ok(mf, "status")).pendingExports, 0);
		const again = await mf.getR2Bucket("ARCHIVE");
		assert.equal((await again.list()).objects.length, 1);
		assert.equal(await (await again.get(firstKey)).text(), body);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("campaign route and immutable registration cannot alias R2 prefix", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	const mf = runtime(path);
	try {
		assert.equal(
			(await call(mf, "register", registration("other"))).body.error,
			"CAMPAIGN_ID_MISMATCH",
		);
		await ok(mf, "register", registration());
		assert.equal(
			(
				await call(mf, "register", {
					...registration(),
					codeSha256: "e".repeat(64),
				})
			).body.error,
			"MANIFEST_CONFLICT",
		);
		await ok(mf, "preflight");
		assert.equal((await ok(mf, "status")).prospectivePhase, "preflight");
		assert.equal(
			(await call(mf, "start")).body.error,
			"PROSPECTIVE_ACTIVATION_DISABLED",
		);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("reboot during durable REQUEST suspends without refetching", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	let requested;
	const arrived = new Promise((r) => {
		requested = r;
	});
	const calls = [];
	let mf = runtime(path, async (request) => {
		calls.push((await request.json()).id);
		requested();
		return new Promise(() => {});
	});
	try {
		await ok(mf, "register", registration());
		const pending = call(mf, "wake", { at: T0 }).catch(() => null);
		await arrived;
		await mf.dispose();
		await pending;
		mf = runtime(path, async (r) => {
			calls.push((await r.clone().json()).id);
			return fixture(r);
		});
		const s = await ok(mf, "status");
		assert.equal(s.state.campaign.phase, "suspended");
		assert.ok(
			s.state.campaign.reasons.includes("RESPONSE_UNOBSERVED_AT_RECOVERY"),
		);
		await ok(mf, "wake", { at: T0 + 1000 });
		assert.equal(calls.filter((id) => id === "bh-BTC-USD").length, 1);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
const rising = async (request) => {
	const p = await request.clone().json();
	if (p.kind === "candles")
		return Response.json(
			Array.from({ length: 240 }, (_, i) => ({
				start: p.candleClosedAt - (240 - i) * DAY,
				close: 100 + i * 0.1 + (i % 2) * 0.05,
			})),
		);
	return fixture(request);
};
test("P7 BUY uses broker and after-fill joint marks precede next P7 pricing", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	const mf = runtime(path, rising);
	try {
		await ok(mf, "register", registration());
		await ok(mf, "wake", { at: T0 });
		const s = await ok(mf, "status");
		assert.equal(
			s.state.ledger.slots[`BTC-USD:${T0}`].outcome.kind,
			"SIMULATED_FILL",
		);
		assert.equal(
			s.state.ledger.slots[`ETH-USD:${T0}`].outcome.kind,
			"SIMULATED_FILL",
		);
		assert.ok(s.state.ledger.portfolios["BTC-USD"].cash >= 0);
		const sql = await mf.unsafeGetDurableObjectStorage(
			"collector",
			"P7Campaign",
			{ name: "test" },
		);
		const entries = (
			await sql.exec("SELECT body FROM journal ORDER BY sequence")
		).map((r) => JSON.parse(r.body));
		const fills = entries.filter(
			(e) => e.command?.event?.outcome?.kind === "SIMULATED_FILL",
		);
		assert.equal(fills.length, 2);
		const mark = entries.find(
			(e) =>
				e.command?.markId === `fill-${fills[0].sequence}` &&
				e.command.event.type === "OBSERVE_EVENT_MARK",
		);
		assert.ok(mark.sequence < fills[1].sequence);
		assert.equal(
			Object.values(s.state.events.slots)
				.filter((v) => v.kind === "AFTER_FILL")
				.every((v) => v.phase === "observed"),
			true,
		);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("5 second source timeout preserves failed evidence and cannot manufacture fill", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	const mf = runtime(path, async (r) => {
		const p = await r.clone().json();
		if (p.id.includes("daily-BTC") && p.kind === "book")
			return new Promise(() => {});
		return rising(r);
	});
	try {
		await ok(mf, "register", registration());
		await ok(mf, "wake", { at: T0 });
		const s = await ok(mf, "status");
		assert.equal(
			s.state.ledger.slots[`BTC-USD:${T0}`].outcome.kind,
			"QUOTE_REJECTED",
		);
		assert.equal(s.state.ledger.portfolios["BTC-USD"].positionQuantity, 0);
		const sql = await mf.unsafeGetDurableObjectStorage(
			"collector",
			"P7Campaign",
			{ name: "test" },
		);
		const rows = await sql.exec(
			"SELECT response,status FROM requests WHERE id LIKE '%BTC-USD%quote'",
		);
		assert.equal(rows[0].status, "CAPTURED");
		assert.equal(rows[0].response, "null");
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("FINAL captures before T1, survives restart, observes at T1 without refetch or new fill", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	const ids = [];
	const source = async (r) => {
		ids.push((await r.clone().json()).id);
		return fixture(r);
	};
	let mf = runtime(path, source);
	try {
		await ok(mf, "register", registration());
		const end = T0 + 180 * DAY;
		await ok(mf, "wake", { at: end - 4000 });
		let s = await ok(mf, "status");
		assert.equal(s.state.events.slots.FINAL.phase, "requested");
		const calls = ids.length;
		await mf.dispose();
		mf = runtime(path, source);
		await ok(mf, "wake", { at: end });
		s = await ok(mf, "status");
		assert.equal(s.state.events.slots.FINAL.phase, "observed");
		assert.equal(s.state.events.slots.FINAL.observation.asOf, end);
		assert.equal(ids.length, calls);
		assert.equal(s.state.ledger.portfolios["BTC-USD"].positionQuantity, 0);
		assert.equal(s.state.campaign.phase, "ended");
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("actual alarm advances clock and completes hourly work, suspension schedules bounded diagnostics", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	const mf = runtime(path);
	try {
		await ok(mf, "register", registration());
		await ok(mf, "wake", { at: T0 });
		await ok(mf, "wake", { at: T0 + 3600000 - 150 });
		await ok(mf, "alarm");
		for (let i = 0; i < 80; i++) {
			if (
				(await ok(mf, "status")).state.marks.slots[T0 + 3600000]?.phase ===
				"observed"
			)
				break;
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.equal(
			(await ok(mf, "status")).state.marks.slots[T0 + 3600000].phase,
			"observed",
		);
		await ok(mf, "wake", { at: T0 + 4 * 3600000 });
		assert.equal((await ok(mf, "status")).state.campaign.phase, "suspended");
		const sql = await mf.unsafeGetDurableObjectStorage(
			"collector",
			"P7Campaign",
			{ name: "test" },
		);
		const next = await sql.exec(
			"SELECT body FROM metadata WHERE key='next-wake'",
		);
		assert.ok(Number(next[0].body) >= T0 + 5 * 3600000);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("J30 assessment uses frozen sequence/hash prefix and later state cannot change report", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	const mf = runtime(path, rising);
	try {
		await ok(mf, "register", registration());
		await ok(mf, "wake", { at: T0 });
		await ok(mf, "wake", { at: T0 + 30 * DAY });
		const first = await ok(mf, "assess", { checkpoint: 30 });
		assert.ok(first.result.checkpointSequence > 0);
		assert.match(first.result.checkpointHash, /^[a-f0-9]{64}$/);
		assert.equal(
			first.result.technical.reasons.includes(
				"ACCOUNTING_OR_JOURNAL_INVARIANT_BREACH",
			),
			false,
		);
		await ok(mf, "wake", { at: T0 + 31 * DAY });
		const second = await ok(mf, "assess", { checkpoint: 30 });
		assert.deepEqual(second, first);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("lost FINAL request terminates unavailable at T1 without refetch and allows J180", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	let arrived;
	const waiting = new Promise((r) => {
		arrived = r;
	});
	let calls = 0;
	let mf = runtime(path, async () => {
		calls++;
		arrived();
		return new Promise(() => {});
	});
	try {
		await ok(mf, "register", registration());
		const end = T0 + 180 * DAY;
		const pending = call(mf, "wake", { at: end - 4000 }).catch(() => null);
		await waiting;
		await mf.dispose();
		await pending;
		mf = runtime(path, async (r) => {
			calls++;
			return fixture(r);
		});
		await ok(mf, "wake", { at: end });
		const s = await ok(mf, "status");
		assert.equal(s.state.events.slots.FINAL.phase, "requested");
		assert.ok(
			s.jobs.some(
				(j) =>
					j.id === "FINAL" &&
					JSON.parse(j.body).result.unavailable === "FINAL_RESPONSE_UNOBSERVED",
			),
		);
		const report = await ok(mf, "assess", { checkpoint: 180 });
		assert.equal(report.result.syntheticVerdict, "INCONCLUSIVE");
		assert.equal(calls, 1);
		await ok(mf, "alarm");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(calls, 1);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("600KB valid raw capture is complete in bounded SQLite chunks, oversize Unicode/invalid JSON retain only bounded provenance", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	const rawById = new Map();
	const mf = runtime(path, async (request) => {
		const p = await request.clone().json();
		let text;
		if (p.kind === "candles")
			text =
				p.productId === "BTC-USD"
					? JSON.stringify("😀".repeat(300000))
					: `{${"x".repeat(1200000)}`;
		else if (p.id.startsWith("hourly-"))
			text = JSON.stringify("😀".repeat(150000));
		else text = " ".repeat(600000) + (await (await fixture(request)).text());
		rawById.set(p.id, text);
		return new Response(text);
	});
	try {
		await ok(mf, "register", registration());
		await ok(mf, "wake", { at: T0 });
		const sql = await mf.unsafeGetDurableObjectStorage(
			"collector",
			"P7Campaign",
			{ name: "test" },
		);
		const receipts = (
			await sql.exec(
				"SELECT input FROM journal WHERE command_id LIKE 'capture-%'",
			)
		).map((r) => JSON.parse(r.input));
		const normal = receipts.find((r) => r.id === "bh-BTC-USD");
		assert.ok(normal.rawBytes > 600000);
		assert.ok(normal.rawChunks > 1);
		assert.equal(normal.bodyComplete, true);
		assert.equal(
			normal.rawSha256,
			createHash("sha256").update(rawById.get("bh-BTC-USD")).digest("hex"),
		);
		const chunks = await sql.exec(
			"SELECT body FROM captures WHERE raw_hash=? ORDER BY part",
			normal.rawSha256,
		);
		assert.equal(chunks.map((r) => r.body).join(""), rawById.get("bh-BTC-USD"));
		for (const product of ["BTC-USD", "ETH-USD"]) {
			const rejected = receipts.find(
				(r) => r.id === `daily-${product}-${T0}-candles`,
			);
			assert.equal(rejected.rejection, "SOURCE_TOO_LARGE");
			assert.equal(rejected.rawChunks, 0);
			assert.ok(rejected.rawBytes > 1048576);
			assert.equal(rejected.rawSha256, null);
			assert.equal(rejected.bodyComplete, false);
			assert.equal(rejected.rawBytesScope, "OBSERVED_LOWER_BOUND");
			assert.match(rejected.rawPrefixSha256, /^[a-f0-9]{64}$/);
			assert.ok(rejected.prefixBytes <= 65536);
		}
		const unicode = receipts.find((r) => r.id === `hourly-${T0}-BTC-USD`);
		assert.equal(unicode.rejection, "NORMALIZED_PAYLOAD_TOO_LARGE");
		assert.equal(
			unicode.rawSha256,
			createHash("sha256")
				.update(rawById.get(`hourly-${T0}-BTC-USD`))
				.digest("hex"),
		);
		assert.ok(unicode.rawBytes > 600000 && unicode.rawChunks > 1);
		const unicodeChunks = await sql.exec(
			"SELECT body FROM captures WHERE raw_hash=? ORDER BY part",
			unicode.rawSha256,
		);
		assert.equal(
			unicodeChunks.map((r) => r.body).join(""),
			rawById.get(`hourly-${T0}-BTC-USD`),
		);
		const max = await sql.exec(
			"SELECT MAX(length(CAST(input AS BLOB))+length(CAST(body AS BLOB))) AS bytes FROM journal",
		);
		assert.ok(max[0].bytes < 100000);
		assert.equal(
			(await ok(mf, "status")).state.benchmarks.products["BTC-USD"].phase,
			"initialized",
		);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("actual crash after durable ADMIT suspends without inventing decision or fetching candles again", async () => {
	await build({
		entryPoints: ["test/fault-worker.ts"],
		outfile: "dist/fault-worker.js",
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2023",
		external: ["cloudflare:workers"],
	});
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	let reached;
	const barrier = new Promise((r) => {
		reached = r;
	});
	let candles = 0;
	const source = async (r) => {
		if ((await r.clone().json()).kind === "candles") candles++;
		return rising(r);
	};
	const opts = (crash) => ({
		...convertV4MiniflareOptions({
			name: "collector",
			modules: true,
			scriptPath: "dist/fault-worker.js",
			compatibilityDate: "2026-08-20",
			resourcePersistencePath: path,
			durableObjects: {
				CAMPAIGNS: { className: "FaultCampaign", useSQLite: true },
			},
			r2Buckets: ["ARCHIVE"],
			bindings: {
				LOCAL_FIXTURES_ENABLED: "true",
				CRASH_AFTER_ADMIT: String(crash),
			},
			serviceBindings: {
				FIXTURE_SOURCE: source,
				BARRIER: async () => {
					reached();
					return new Promise(() => {});
				},
			},
		}),
		unsafeInspectDurableObjects: true,
	});
	let mf = new Miniflare(opts(true));
	try {
		await ok(mf, "register", registration());
		const pending = call(mf, "wake", { at: T0 }).catch(() => null);
		await barrier;
		await mf.dispose();
		await pending;
		mf = new Miniflare(opts(false));
		const recovered = await ok(mf, "status");
		const admitted = recovered.state.ledger.slots[`BTC-USD:${T0}`];
		assert.equal(admitted.phase, "admitted");
		assert.equal(recovered.state.campaign.phase, "suspended");
		await ok(mf, "wake", { at: T0 + 1000 });
		const after = await ok(mf, "status");
		assert.deepEqual(
			after.state.ledger.slots[`BTC-USD:${T0}`].admission,
			admitted.admission,
		);
		assert.equal(after.state.ledger.slots[`BTC-USD:${T0}`].outcome, null);
		assert.ok(
			after.jobs.some(
				(j) =>
					j.id === `daily-BTC-USD-${T0}` &&
					JSON.parse(j.body).result.unresolved,
			),
		);
		assert.equal(candles, 1);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("crashed daily REQUEST after deadline completes unknown job and permits diagnostics and checkpoint", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	let reached;
	const barrier = new Promise((r) => {
		reached = r;
	});
	let quoteCalls = 0;
	const source = async (r) => {
		const p = await r.clone().json();
		if (p.id === `daily-BTC-USD-${T0}-quote`) {
			quoteCalls++;
			reached();
			return new Promise(() => {});
		}
		return rising(r);
	};
	let mf = runtime(path, source);
	try {
		await ok(mf, "register", registration());
		const pending = call(mf, "wake", { at: T0 }).catch(() => null);
		await barrier;
		await mf.dispose();
		await pending;
		mf = runtime(path, source);
		await ok(mf, "wake", { at: T0 + 7200001 });
		const s = await ok(mf, "status");
		assert.equal(s.state.ledger.slots[`BTC-USD:${T0}`].phase, "requested");
		assert.ok(
			s.jobs.some(
				(j) =>
					j.id === `daily-BTC-USD-${T0}` &&
					JSON.parse(j.body).result.unresolved,
			),
		);
		assert.equal(s.state.marks.slots[T0 + 7200000].phase, "observed");
		const sql = await mf.unsafeGetDurableObjectStorage(
			"collector",
			"P7Campaign",
			{ name: "test" },
		);
		const next = await sql.exec(
			"SELECT body FROM metadata WHERE key='next-wake'",
		);
		assert.ok(Number(next[0].body) >= T0 + 10800000);
		await ok(mf, "wake", { at: T0 + 30 * DAY });
		const report = await ok(mf, "assess", { checkpoint: 30 });
		assert.ok(report.result.technical.reasons.includes("RESPONSE_UNOBSERVED"));
		assert.equal(quoteCalls, 1);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
test("5s deadline covers a fast header response with a permanently stalled body stream", async () => {
	const path = await mkdtemp(join(tmpdir(), "p7-worker-"));
	const mf = runtime(path, async (request) => {
		const p = await request.clone().json();
		if (p.id === `daily-BTC-USD-${T0}-quote`)
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"pending":'));
					},
				}),
			);
		return rising(request);
	});
	try {
		await ok(mf, "register", registration());
		const started = Date.now();
		await ok(mf, "wake", { at: T0 });
		assert.ok(Date.now() - started < 10000);
		const s = await ok(mf, "status");
		assert.equal(
			s.state.ledger.slots[`BTC-USD:${T0}`].outcome.kind,
			"QUOTE_REJECTED",
		);
		const sql = await mf.unsafeGetDurableObjectStorage(
			"collector",
			"P7Campaign",
			{ name: "test" },
		);
		const rows = await sql.exec(
			"SELECT input FROM journal WHERE command_id=?",
			`capture-daily-BTC-USD-${T0}-quote`,
		);
		const capture = JSON.parse(rows[0].input);
		assert.equal(capture.rejection, "SOURCE_TIMEOUT");
		assert.equal(capture.bodyComplete, false);
		assert.equal(capture.rawSha256, null);
		assert.match(capture.rawPrefixSha256, /^[a-f0-9]{64}$/);
		assert.equal(capture.rawChunks, 0);
	} finally {
		await mf.dispose();
		await rm(path, { recursive: true, force: true });
	}
});
