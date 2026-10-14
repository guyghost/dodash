import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const aggregateSourceDiagnostics = (archives) => {
	const runs = new Map();
	const conflicts = [];
	const invalidHarness = new Map([
		[
			"58048a42-1244-4cd8-ab41-b28ac8173cc1",
			"Known pre-fix workerd redirect:error failure before outbound network; not provider availability evidence.",
		],
	]);
	const ignored = [];
	const visit = (value, path, trigger = null) => {
		if (Array.isArray(value)) {
			value.forEach((v, i) => {
				visit(v, `${path}[${i}]`, trigger);
			});
			return;
		}
		if (value === null || typeof value !== "object") return;
		if (value.protocol === "market-source-probe-v1") {
			if (
				value.phase !== "completed" ||
				typeof value.runId !== "string" ||
				!Array.isArray(value.observations)
			) {
				ignored.push(path);
				return;
			}
			const previous = runs.get(value.runId);
			if (previous) {
				previous.files.push(path);
				if (JSON.stringify(previous.report) !== JSON.stringify(value))
					conflicts.push({ runId: value.runId, file: path });
			} else
				runs.set(value.runId, {
					report: value,
					files: [path],
					trigger: value.trigger ?? trigger,
				});
			return;
		}
		for (const [key, child] of Object.entries(value))
			visit(child, `${path}.${key}`, value.trigger ?? trigger);
	};
	for (const { path, value } of archives) visit(value, path);
	const groups = new Map();
	const excludedRuns = [...runs]
		.filter(([id]) => invalidHarness.has(id))
		.map(([runId, r]) => ({
			runId,
			files: r.files,
			reason: invalidHarness.get(runId),
		}));
	const diagnosticRuns = conflicts.length
		? []
		: [...runs.values()].filter((r) => !invalidHarness.has(r.report.runId));
	for (const { report } of diagnosticRuns)
		for (const row of report.observations) {
			const { provider, product, kind } = row.request ?? {};
			const key = `${provider}/${product}/${kind}`;
			const group = groups.get(key) ?? {
				provider,
				product,
				kind,
				observations: 0,
				outcomes: {},
				statuses: {},
				candleCoverage: [],
				priceKinds: {},
				readyCandles: 0,
				executionBookQualified: false,
			};
			group.observations++;
			const status =
				row.status === null || row.status === undefined
					? "NO_STATUS"
					: String(row.status);
			group.statuses[status] = (group.statuses[status] ?? 0) + 1;
			if (kind === "candles")
				group.candleCoverage.push({
					runId: report.runId,
					requestedAt: row.startedAt ?? null,
					receivedAt: row.completedAt ?? null,
					request: row.request,
					expectedWindowStart: Number.isSafeInteger(report.closedAt)
						? report.closedAt - 240 * 86400000
						: null,
					expectedWindowEndExclusive: report.closedAt ?? null,
					expectedLastStart: Number.isSafeInteger(report.closedAt)
						? report.closedAt - 86400000
						: null,
					expectedCount: 240,
					receivedCount: row.data?.received ?? null,
					closedCount: row.data?.closedCount ?? null,
					missingStarts: row.data?.missingStarts ?? null,
					duplicateStarts: row.data?.duplicateStarts ?? null,
					latestStart: row.data?.latestStart ?? null,
					ready: row.data?.ready ?? null,
					outcome: row.outcome,
					status: row.status ?? null,
				});
			group.outcomes[row.outcome] = (group.outcomes[row.outcome] ?? 0) + 1;
			if (row.data?.kind === "quote")
				group.priceKinds[row.data.priceKind] =
					(group.priceKinds[row.data.priceKind] ?? 0) + 1;
			if (row.data?.kind === "candles" && row.data.ready === true)
				group.readyCandles++;
			groups.set(key, group);
		}
	const cron = diagnosticRuns.filter((r) =>
		["cron", "scheduled"].includes(r.trigger),
	);
	return {
		protocol: "p7-source-diagnostics-offline-v1",
		completedUniqueRuns: runs.size,
		valid: conflicts.length === 0,
		classification: conflicts.length
			? "INVALID_CONFLICTING_ARCHIVES"
			: "DIAGNOSTIC_ONLY",
		availabilityDenominatorRuns: diagnosticRuns.length,
		excludedRuns,
		duplicateFiles: [...runs.values()].reduce(
			(sum, r) => sum + r.files.length - 1,
			0,
		),
		conflictingDuplicates: conflicts,
		ignoredReports: ignored,
		cronEvidence: {
			status: cron.length > 0 ? "OBSERVED" : "UNKNOWN",
			completedObservedRuns: cron.length,
			explanation:
				"Missing archived cron reports do not prove zero scheduled executions.",
		},
		runs: [...runs].map(([runId, r]) => ({
			runId,
			files: r.files,
			startedAt: r.report.startedAt,
			completedAt: r.report.completedAt,
			trigger: r.trigger,
		})),
		groups: [...groups.values()],
		executionSourceSelected: false,
		limitation:
			"Completed diagnostics are not L2 evidence. Ticker last prices never qualify execution books.",
	};
};
const collect = (directory) =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory()
			? collect(path)
			: entry.name.endsWith(".json")
				? [path]
				: [];
	});
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const directories = process.argv.slice(2);
	if (!directories.length)
		throw new Error("Provide archived evidence directories");
	const archives = directories.flatMap(collect).map((path) => ({
		path: relative(process.cwd(), path),
		value: JSON.parse(readFileSync(path, "utf8")),
	}));
	console.log(JSON.stringify(aggregateSourceDiagnostics(archives), null, 2));
}
