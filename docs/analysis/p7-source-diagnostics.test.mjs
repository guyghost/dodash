import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateSourceDiagnostics } from "./p7-source-diagnostics.mjs";

const report = {
	protocol: "market-source-probe-v1",
	phase: "completed",
	runId: "same",
	observations: [
		{
			request: {
				provider: "coinbase-exchange",
				product: "BTC-USD",
				kind: "quote",
			},
			outcome: "OK",
			data: { kind: "quote", priceKind: "last" },
		},
	],
};
test("deduplicates archives and never upgrades last ticker or missing cron evidence", () => {
	const r = aggregateSourceDiagnostics([
		{ path: "a", value: report },
		{ path: "b", value: report },
		{ path: "cron", value: { reports: [] } },
	]);
	assert.equal(r.completedUniqueRuns, 1);
	assert.equal(r.duplicateFiles, 1);
	assert.equal(r.groups[0].observations, 1);
	assert.equal(r.groups[0].executionBookQualified, false);
	assert.equal(r.cronEvidence.status, "UNKNOWN");
});
test("flags conflicting duplicate reports and explicit archived cron", () => {
	const r = aggregateSourceDiagnostics([
		{ path: "a", value: { ...report, trigger: "cron" } },
		{ path: "b", value: report },
		{
			path: "incomplete",
			value: { ...report, runId: "other", phase: "running" },
		},
	]);
	assert.equal(r.conflictingDuplicates.length, 1);
	assert.equal(r.cronEvidence.completedObservedRuns, 0);
	assert.equal(r.valid, false);
	assert.equal(r.groups.length, 0);
	assert.equal(r.ignoredReports.length, 1);
});

test("excludes known invalid harness and preserves 429 plus missing candle windows", () => {
	const candle = {
		...report,
		runId: "good",
		closedAt: 864000000,
		observations: [
			{
				request: {
					provider: "coinbase-exchange",
					product: "BTC-USD",
					kind: "candles",
					url: "archived",
				},
				startedAt: 10,
				completedAt: 20,
				status: 429,
				outcome: "HTTP_ERROR",
			},
			{
				request: {
					provider: "coinbase-exchange",
					product: "BTC-USD",
					kind: "candles",
				},
				status: 200,
				outcome: "OK",
				data: {
					kind: "candles",
					closedCount: 239,
					missingStarts: [1],
					duplicateStarts: [],
					latestStart: 777600000,
					ready: false,
				},
			},
		],
	};
	const result = aggregateSourceDiagnostics([
		{
			path: "bad",
			value: { ...report, runId: "58048a42-1244-4cd8-ab41-b28ac8173cc1" },
		},
		{ path: "good", value: candle },
	]);
	assert.equal(result.completedUniqueRuns, 2);
	assert.equal(result.availabilityDenominatorRuns, 1);
	assert.equal(result.excludedRuns.length, 1);
	assert.equal(result.groups[0].statuses["429"], 1);
	assert.equal(result.groups[0].candleCoverage[0].expectedLastStart, 777600000);
	assert.deepEqual(result.groups[0].candleCoverage[1].missingStarts, [1]);
});

test("explicit scheduled provenance is counted when archive is consistent", () => {
	const r = aggregateSourceDiagnostics([
		{ path: "cron", value: { trigger: "scheduled", reports: [report] } },
	]);
	assert.equal(r.cronEvidence.status, "OBSERVED");
	assert.equal(r.cronEvidence.completedObservedRuns, 1);
});

const reverseKeys = (value) =>
	Array.isArray(value)
		? value.map(reverseKeys)
		: value !== null && typeof value === "object"
			? Object.fromEntries(
					Object.entries(value)
						.reverse()
						.map(([key, child]) => [key, reverseKeys(child)]),
				)
			: value;
test("duplicate JSON object key order is irrelevant at every nesting level", () => {
	const result = aggregateSourceDiagnostics([
		{ path: "original", value: report },
		{
			path: "reordered",
			value: JSON.parse(JSON.stringify(reverseKeys(report))),
		},
	]);
	assert.equal(result.valid, true);
	assert.equal(result.duplicateFiles, 1);
	assert.equal(result.groups[0].observations, 1);
});
test("duplicate array order and nested value differences remain conflicts", () => {
	const twoRows = {
		...report,
		observations: [
			...report.observations,
			{ ...report.observations[0], outcome: "HTTP_ERROR" },
		],
	};
	for (const changed of [
		{ ...twoRows, observations: [...twoRows.observations].reverse() },
		{
			...twoRows,
			observations: [
				{
					...twoRows.observations[0],
					request: { ...twoRows.observations[0].request, product: "ETH-USD" },
				},
				twoRows.observations[1],
			],
		},
	]) {
		const result = aggregateSourceDiagnostics([
			{ path: "original", value: twoRows },
			{ path: "changed", value: changed },
		]);
		assert.equal(result.valid, false);
		assert.equal(result.conflictingDuplicates.length, 1);
		assert.equal(result.groups.length, 0);
	}
});
