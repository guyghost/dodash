import { createRequire } from "node:module";
import { realpathSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const { Miniflare, convertV4MiniflareOptions } = createRequire(
	realpathSync(resolve("node_modules/wrangler/package.json")),
)("miniflare");
const { build } = createRequire(
	realpathSync(resolve("node_modules/wrangler/package.json")),
)("esbuild");
const dir = mkdtempSync(join(tmpdir(), "dodash-paper-runtime-"));
let runtime;
let outboundCalls = 0;
try {
	for (const name of ["fixture-worker", "market-fixture"])
		await build({
			entryPoints: [`scripts/runtime/${name}.ts`],
			outfile: join(dir, `${name}.js`),
			bundle: true,
			banner: {
				js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire('/paper-runtime.js');",
			},
			format: "esm",
			platform: "browser",
			alias: Object.fromEntries(
				[
					"domain",
					"allocator",
					"indicators-prolog",
					"paper-execution",
					"risk",
					"strategies",
				]
					.map((n) => [
						"@dodash/" + n,
						resolve("../../packages/" + n + "/src/index.ts"),
					])
					.concat([["@dodash/models", resolve("../../models/index.ts")]]),
			),
			conditions: ["workerd", "worker", "browser"],
			external: ["cloudflare:*", "node:*"],
			plugins: [
				{
					name: "node-builtins",
					setup(b) {
						b.onResolve(
							{
								filter:
									/^(path|fs|util|stream|events|buffer|os|crypto|child_process)$/,
							},
							(a) => ({ path: "node:" + a.path, external: true }),
						);
					},
				},
			],
		});
	console.log("bundle directory", dir);
	const CLOSE = 1_800_000_000_000;
	const boot = () =>
		new Miniflare(
			Object.assign(
				convertV4MiniflareOptions({
					workers: [
						{
							name: "agent",
							modules: true,
							script: readFileSync(join(dir, "fixture-worker.js"), "utf8"),
							compatibilityDate: "2026-08-18",
							compatibilityFlags: ["nodejs_compat"],
							durableObjects: {
								TRADING_AGENT: {
									className: "PaperRuntimeAgent",
									useSQLite: true,
								},
							},
							bindings: {
								LIVE_TRADING_ENABLED: "false",
								HYPERLIQUID_PERP_TRADING_ENABLED: "false",
								INTERNAL_SERVICE_TOKEN:
									"fixture-only-token-000000000000000000000",
							},
							serviceBindings: { MARKET_DATA: "market" },
							outboundService: () => {
								outboundCalls++;
								throw new Error("EXTERNAL_NETWORK_FORBIDDEN");
							},
						},
						{
							name: "market",
							compatibilityDate: "2026-08-18",
							modules: true,
							script: readFileSync(join(dir, "market-fixture.js"), "utf8"),
							bindings: { CANDLE_CLOSE: CLOSE },
						},
					],
					durableObjectsPersist: join(dir, "sqlite"),
				}),
				{ resourcePersistencePath: join(dir, "sqlite") },
			),
		);
	const call = async (input) => {
		const r = await runtime.dispatchFetch("http://fixture/", {
			method: "POST",
			body: JSON.stringify(input),
		});
		if (!r.ok) throw new Error(await r.text());
		return r.json();
	};
	runtime = boot();
	for (const offset of [-1, 0, 1]) {
		const name = `fresh-${offset}`,
			now = CLOSE + 7_200_000 + offset;
		await call({ action: "prepare", name, now });
		const result = await call({ action: "grid", name, now });
		assert.equal(result.state.portfolio.positionQuantity, 2);
		const ctx = result.state.machine.context;
		const point = result.telemetry.at(-1);
		assert.equal(point.blobs[12], offset <= 0 ? "ADMITTED" : "UNOBSERVED");
		if (offset <= 0) {
			assert.equal(ctx.marketAdmission.evaluatedAt, now);
			assert.equal(ctx.marketAdmission.candleClosedAt, CLOSE);
			assert.equal(ctx.lastError, null);
		} else {
			assert.equal(ctx.lastError.code, "STALE_MARKET_DATA");
			assert.equal(ctx.indicatorsId, null);
			assert.equal(ctx.decisionId, null);
			assert.equal(result.orders.length, 0);
		}
		assert.equal(point.doubles.length, 20);
		if (offset <= 0) {
			assert.equal(point.doubles[18], CLOSE);
			assert.equal(point.doubles[19], now);
		}
		console.log(
			JSON.stringify({
				test: "freshness",
				offset,
				machine: result.state.machine.value,
				error: result.state.machine.context.lastError,
				cycles: result.cycles.length,
			}),
		);
	}
	await call({ action: "prepare", name: "retry", now: CLOSE, pending: true });
	const before = await call({ action: "inspect", name: "retry", now: CLOSE });
	const early = await call({
		action: "dispatch",
		name: "retry",
		now: CLOSE,
		payload: {
			productId: null,
			attempt: 1,
			nextRetryAt: CLOSE + 60_000,
			rearm: 0,
		},
	});
	assert.deepEqual(early.state.machine, before.state.machine);
	assert.deepEqual(early.state.portfolio, before.state.portfolio);
	const rearms = early.schedules.filter((s) => s.callback === "retryTick");
	assert.equal(rearms.length, 1);
	assert.equal(rearms[0].time, (CLOSE + 60_000) / 1_000);
	assert.equal(rearms[0].payload.rearm, 1);
	assert.equal(rearms[0].payload.nextRetryAt, CLOSE + 60_000);
	const bounded = await call({
		action: "retry",
		name: "retry",
		now: CLOSE,
		payload: {
			productId: null,
			attempt: 1,
			nextRetryAt: CLOSE + 60_000,
			rearm: 3,
		},
	});
	assert.deepEqual(bounded.schedules, early.schedules);
	assert.deepEqual(bounded.state.machine, early.state.machine);
	const orphanBefore = await call({
		action: "inspect",
		name: "fresh-0",
		now: CLOSE + 7_200_000,
	});
	const orphan = await call({
		action: "retry",
		name: "fresh-0",
		now: CLOSE + 7_200_000,
		payload: { productId: null, attempt: 1, nextRetryAt: CLOSE, rearm: 0 },
	});
	assert.deepEqual(orphan.state, orphanBefore.state);
	assert.deepEqual(orphan.telemetry, orphanBefore.telemetry);
	for (const newCandle of [false, true]) {
		const name = "grid-" + newCandle;
		await call({ action: "market", close: CLOSE });
		await call({
			action: "prepare",
			name,
			now: CLOSE,
			pending: true,
			staleness: newCandle ? 90_000 : 7_200_000,
		});
		if (newCandle) await call({ action: "market", close: CLOSE + 60_000 });
		const grid = await call({ action: "grid", name, now: CLOSE + 120_000 });
		assert.equal(grid.cycles.length, 2);
		const published = grid.telemetry.filter(
			(p) => p.blobs[0] === "cycle.completed",
		);
		assert.equal(published.length, 2);
		assert.equal(published[0].blobs[10], "fixture-old");
		assert.notEqual(published[1].blobs[10], "fixture-old");
		assert.notEqual(published[0].blobs[4], "RUNNING");
		assert.notEqual(published[1].blobs[5], "DUPLICATE_ALARM");
		assert.equal(grid.orders.length, 0);
		if (!newCandle) {
			assert.equal(grid.state.machine.context.indicatorsId, null);
			assert.equal(grid.state.machine.context.decisionId, null);
		}
		assert.notEqual(grid.cycles[0].cycle_id, grid.cycles[1].cycle_id);
		assert.notEqual(
			grid.state.machine.context.lastError?.code,
			"DUPLICATE_ALARM",
		);
		assert.equal(
			grid.telemetry.at(-1).blobs[12],
			newCandle ? "ADMITTED" : "UNOBSERVED",
		);
	}
	await call({ action: "market", close: CLOSE });
	await call({
		action: "prepare",
		name: "multi",
		now: CLOSE,
		pending: true,
		multi: true,
	});
	const multiBefore = await call({
		action: "inspect",
		name: "multi",
		now: CLOSE,
	});
	const multiAfter = await call({
		action: "retry",
		name: "multi",
		now: CLOSE + 60_000,
		payload: {
			productId: "BTC-USD",
			attempt: 1,
			nextRetryAt: CLOSE + 60_000,
			rearm: 0,
		},
	});
	assert.deepEqual(
		multiAfter.state.portfolioSession.products["ETH-USD"],
		multiBefore.state.portfolioSession.products["ETH-USD"],
	);
	const btc = multiAfter.state.portfolioSession.products["BTC-USD"].machine;
	assert.equal(btc.value, "waiting");
	assert.equal(btc.context.outcome, "NO_ACTION");
	assert.equal(btc.context.marketAdmission.evaluatedAt, CLOSE + 60_000);
	assert.equal(multiAfter.telemetry.at(-1).blobs[1], "BTC-USD");
	assert.equal(multiAfter.cycles[0].outcome, "NO_ACTION");
	const admissionBefore = await call({
		action: "inspect",
		name: "fresh-0",
		now: CLOSE + 7_200_000,
	});
	await runtime.dispose();
	runtime = boot();
	const admissionAfter = await call({
		action: "inspect",
		name: "fresh-0",
		now: CLOSE + 7_200_000,
	});
	assert.deepEqual(admissionAfter.telemetry, admissionBefore.telemetry);
	assert.deepEqual(admissionAfter.cycles, admissionBefore.cycles);
	const persistedArtifacts = JSON.parse(
		admissionAfter.cycles[0].artifacts_json,
	);
	assert.equal(persistedArtifacts.triggeredAt, CLOSE + 7_200_000);
	assert.equal(persistedArtifacts.market.candles.at(-1).start + 60_000, CLOSE);
	assert.equal(outboundCalls, 0);
	assert.deepEqual(
		admissionAfter.state.machine.context.marketAdmission,
		admissionBefore.state.machine.context.marketAdmission,
	);
	const restored = await call({ action: "inspect", name: "retry", now: CLOSE });
	assert.deepEqual(restored.state.machine, before.state.machine);
	assert.deepEqual(restored.state.portfolio, before.state.portfolio);
	assert.equal(restored.cycles[0].cycle_id, "fixture-old");
	console.log(
		"PASS real SDK dispatcher, early retry rearm, SQLite restart and positions",
	);
} finally {
	await runtime?.dispose();
	rmSync(dir, { recursive: true, force: true });
}
