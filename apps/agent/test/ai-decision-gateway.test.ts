import type { AiDecisionRequest, AiQuestion } from "@dodash/models";
import { describe, expect, it, vi } from "vitest";
import { requestGatewayDecision } from "../src/ai-decision-gateway.js";

const questions: readonly AiQuestion[] = [
	{
		kind: "PREDICATE",
		id: "urgent",
		instructions: "La requête est-elle urgente ?",
	},
	{
		kind: "CHOICE",
		id: "team",
		instructions: "Quelle équipe ?",
		options: ["trading", "infra"],
	},
];

const request: AiDecisionRequest = {
	provider: "jev",
	state: { text: "Cycle terminé sans décision." },
	questions,
	timeoutMs: 500,
};

const deps = (fetchImpl: typeof fetch, ticks: number[] = [1_000, 1_120]) => ({
	gatewayKey: "test-key",
	baseUrl: "https://gateway.test/v1",
	fetchImpl,
	nowMs: () => (ticks.length > 1 ? (ticks.shift() ?? 0) : (ticks[0] ?? 0)),
});

describe("ai decision gateway adapter", () => {
	it("answers with the mapped wire format and measured latency", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => {
			return new Response(
				JSON.stringify({
					answers: [
						{
							type: "predicate",
							name: "urgent",
							probability: 0.9,
							confidence: 0.9,
						},
						{
							type: "choice",
							name: "team",
							choice: "trading",
							confidence: 0.7,
						},
					],
					usage: { input_tokens: 412 },
				}),
				{ status: 200 },
			);
		});
		const result = await requestGatewayDecision(
			"jev",
			request,
			deps(fetchMock as unknown as typeof fetch),
		);
		expect(result).toEqual({
			kind: "ANSWERED",
			answers: [
				{ kind: "PREDICATE", id: "urgent", probability: 0.9 },
				{ kind: "CHOICE", id: "team", probabilities: { trading: 0.7 } },
			],
			latencyMs: 120,
			inputTokens: 412,
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://gateway.test/v1/decisions");
		const body = JSON.parse(String(init?.body));
		expect(body.model).toBe("typesafe-ai/jev");
		expect(body.input).toBe("Cycle terminé sans décision.");
		expect(body.questions).toEqual([
			{
				type: "predicate",
				name: "urgent",
				instructions: "La requête est-elle urgente ?",
			},
			{
				type: "choice",
				name: "team",
				instructions: "Quelle équipe ?",
				choices: [
					{ value: "trading", description: "trading" },
					{ value: "infra", description: "infra" },
				],
			},
		]);
	});

	it("carries per-option probabilities through (probe shape, 2026-10-30)", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => {
			return new Response(
				JSON.stringify({
					answers: [
					{
						type: "choice",
						name: "team",
						choice: "trading",
						confidence: 1,
						probabilities: [
							{ value: "trading", probability: 0.75 },
							{ value: "infra", probability: 0.25 },
						],
					},
					{ type: "predicate", name: "urgent", probability: 0.4 },
					],
					usage: { input_tokens: 412 },
				}),
				{ status: 200 },
			);
		});
		const result = await requestGatewayDecision(
				"jev",
				request,
				deps(fetchMock as unknown as typeof fetch, [0, 1]),
		);
		expect(result).toEqual({
			kind: "ANSWERED",
			answers: [
				{ kind: "PREDICATE", id: "urgent", probability: 0.4 },
				{ kind: "CHOICE", id: "team", probabilities: { trading: 0.75, infra: 0.25 } },
			],
			latencyMs: 1,
			inputTokens: 412,
		});
	});

	it("resolves the openai-decisions provider to its gateway model", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => {
			return new Response(
				JSON.stringify({
					answers: [{ type: "predicate", name: "urgent", probability: 0.5 }],
				}),
				{ status: 200 },
			);
		});
		await requestGatewayDecision(
			"openai-decisions",
			request,
			deps(fetchMock as unknown as typeof fetch, [0, 1]),
		);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://gateway.test/v1/decisions");
		expect(JSON.parse(String(init?.body)).model).toBe(
			"openai/gpt-6-luna-decisions",
		);
	});

	it("turns a refusal into REFUSED with the concerned ids", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => {
			return new Response(
				JSON.stringify({
					answers: [
						{ type: "refusal", name: "team" },
						{ type: "predicate", name: "urgent", probability: 0.9 },
					],
				}),
				{ status: 200 },
			);
		});
		const result = await requestGatewayDecision(
			"jev",
			request,
			deps(fetchMock as unknown as typeof fetch, [0, 1]),
		);
		expect(result).toEqual({ kind: "REFUSED", refusedIds: ["team"] });
	});

	it.each([
		["rate limited (429)", 429, "AI_QUOTA"],
		["unauthorized (401)", 401, "AI_PROVIDER_ERROR"],
		["server error (503)", 503, "AI_PROVIDER_ERROR"],
	])("maps %s to %s", async (_name, status, errorCode) => {
		const fetchMock = vi.fn<typeof fetch>(
			async () => new Response(null, { status }),
		);
		const result = await requestGatewayDecision(
			"jev",
			request,
			deps(fetchMock as unknown as typeof fetch, [0, 1]),
		);
		expect(result).toEqual({ kind: "FAILED", errorCode });
	});

	it("maps an aborted call to AI_TIMEOUT and a network error to AI_PROVIDER_ERROR", async () => {
		const aborted = vi.fn<typeof fetch>(async () => {
			throw new DOMException(
				"The operation was aborted due to timeout",
				"TimeoutError",
			);
		});
		expect(
			await requestGatewayDecision(
				"jev",
				request,
				deps(aborted as unknown as typeof fetch, [0, 1]),
			),
		).toEqual({ kind: "FAILED", errorCode: "AI_TIMEOUT" });

		const broken = vi.fn<typeof fetch>(async () => {
			throw new Error("network down");
		});
		expect(
			await requestGatewayDecision(
				"jev",
				request,
				deps(broken as unknown as typeof fetch, [0, 1]),
			),
		).toEqual({ kind: "FAILED", errorCode: "AI_PROVIDER_ERROR" });
	});

	it("maps a malformed body to AI_SCHEMA_MISMATCH", async () => {
		const fetchMock = vi.fn<typeof fetch>(
			async () => new Response("not json", { status: 200 }),
		);
		expect(
			await requestGatewayDecision(
				"jev",
				request,
				deps(fetchMock as unknown as typeof fetch, [0, 1]),
			),
		).toEqual({ kind: "FAILED", errorCode: "AI_SCHEMA_MISMATCH" });
	});

	it("rejects an image state before any call (v1 transport)", async () => {
		const fetchMock = vi.fn<typeof fetch>(
			async () => new Response("{}", { status: 200 }),
		);
		const invalid: AiDecisionRequest = {
			...request,
			state: { text: "x", images: [{ mediaType: "image/png", base64: "" }] },
		};
		expect(
			await requestGatewayDecision(
				"jev",
				invalid,
				deps(fetchMock as unknown as typeof fetch, [0, 1]),
			),
		).toEqual({ kind: "FAILED", errorCode: "AI_SCHEMA_MISMATCH" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects the clef provider before any call (binding transport, not gateway)", async () => {
		const fetchMock = vi.fn<typeof fetch>(
			async () => new Response("{}", { status: 200 }),
		);
		expect(
			await requestGatewayDecision(
				"clef",
				request,
				deps(fetchMock as unknown as typeof fetch, [0, 1]),
			),
		).toEqual({ kind: "FAILED", errorCode: "AI_PROVIDER_ERROR" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
