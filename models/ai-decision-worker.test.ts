import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	AI_MAX_IMAGES,
	AI_MAX_QUESTIONS,
	type AiDecisionRequest,
	type AiQuestion,
	isRetryableAiErrorCode,
	mapClefQuestions,
	mapOpenAiQuestions,
	parseClefAnswers,
	parseOpenAiAnswers,
	validateAiDecisionRequest,
} from "./ai-decision-worker.js";

const predicate: AiQuestion = {
	kind: "PREDICATE",
	id: "urgent",
	instructions: "La requête est-elle urgente ?",
};
const questions: readonly AiQuestion[] = [
	predicate,
	{
		kind: "CHOICE",
		id: "team",
		instructions: "Quelle équipe ?",
		options: ["trading", "infra"],
	},
	{
		kind: "SCORE",
		id: "severity",
		instructions: "Sévérité ?",
		levels: ["mineur", "majeur", "critique"],
	},
];

const request: AiDecisionRequest = {
	provider: "clef",
	state: { text: "État du cycle." },
	questions,
	timeoutMs: 500,
};

describe("ai decision port — request validation", () => {
	it("accepts a bounded request", () => {
		expect(validateAiDecisionRequest(request)).toEqual({ ok: true });
	});

	it.each<[string, AiDecisionRequest]>([
		["empty questions", { ...request, questions: [] }],
		[
			"too many questions",
			{
				...request,
				questions: Array.from(
					{ length: AI_MAX_QUESTIONS + 1 },
					(_, i): AiQuestion => ({
						kind: "PREDICATE",
						id: `q${i}`,
						instructions: "i",
					}),
				),
			},
		],
		["duplicate ids", { ...request, questions: [predicate, predicate] }],
		[
			"invalid id characters",
			{ ...request, questions: [{ ...predicate, id: "étrange id" }] },
		],
		[
			"choice with fewer than two options",
			{
				...request,
				questions: [
					predicate,
					{ kind: "CHOICE", id: "solo", instructions: "i", options: ["seul"] },
				],
			},
		],
		[
			"choice with duplicate options",
			{
				...request,
				questions: [
					predicate,
					{ kind: "CHOICE", id: "dup", instructions: "i", options: ["a", "a"] },
				],
			},
		],
		[
			"score with duplicate levels",
			{
				...request,
				questions: [
					predicate,
					{
						kind: "SCORE",
						id: "lvl",
						instructions: "i",
						levels: ["bas", "bas"],
					},
				],
			},
		],
		["state without evidence", { ...request, state: {} }],
		[
			"too many images",
			{
				...request,
				state: {
					text: "x",
					images: Array.from({ length: AI_MAX_IMAGES + 1 }, () => ({
						mediaType: "image/png" as const,
						base64: "",
					})),
				},
			},
		],
		["non-positive timeout", { ...request, timeoutMs: 0 }],
		["fractional timeout", { ...request, timeoutMs: 1.5 }],
	])("rejects %s", (_name, invalid) => {
		expect(validateAiDecisionRequest(invalid)).toEqual({
			ok: false,
			errorCode: "AI_SCHEMA_MISMATCH",
		});
	});

	it("retries only timeouts and provider errors", () => {
		expect(isRetryableAiErrorCode("AI_TIMEOUT")).toBe(true);
		expect(isRetryableAiErrorCode("AI_PROVIDER_ERROR")).toBe(true);
		expect(isRetryableAiErrorCode("AI_QUOTA")).toBe(false);
		expect(isRetryableAiErrorCode("AI_SCHEMA_MISMATCH")).toBe(false);
		expect(isRetryableAiErrorCode("AI_REFUSED")).toBe(false);
	});
});

describe("ai decision port — clef mapping", () => {
	it("maps questions to the clef record (noul/choice/score)", () => {
		expect(mapClefQuestions(questions)).toEqual({
			urgent: { type: "noul", instructions: "La requête est-elle urgente ?" },
			team: {
				type: "choice",
				instructions: "Quelle équipe ?",
				criteria: { trading: "trading", infra: "infra" },
			},
			severity: {
				type: "score",
				instructions: "Sévérité ?",
				criteria: ["mineur", "majeur", "critique"],
			},
		});
	});

	it("parses a clef response with per-option probabilities and usage", () => {
		const parsed = parseClefAnswers(questions, {
			answers: {
				urgent: { type: "noul", probability: 0.9 },
				team: { type: "choice", probabilities: { trading: 0.7, infra: 0.3 } },
				severity: { type: "score", score: 2 },
			},
			usage: { inputTokens: 412 },
		});
		expect(parsed).toEqual({
			kind: "ANSWERED",
			answers: [
				{ kind: "PREDICATE", id: "urgent", probability: 0.9 },
				{
					kind: "CHOICE",
					id: "team",
					probabilities: { trading: 0.7, infra: 0.3 },
				},
				{ kind: "SCORE", id: "severity", score: 2 },
			],
			inputTokens: 412,
		});
	});

	it.each([
		[
			"missing answer",
			{ answers: { urgent: { type: "noul", probability: 0.5 } } },
		],
		[
			"noul without probability",
			{
				answers: {
					urgent: { type: "noul" },
					team: { type: "choice", probabilities: { trading: 1 } },
					severity: { type: "score", score: 0 },
				},
			},
		],
		[
			"probability out of range",
			{
				answers: {
					urgent: { type: "noul", probability: 1.5 },
					team: { type: "choice", probabilities: { trading: 1 } },
					severity: { type: "score", score: 0 },
				},
			},
		],
		[
			"choice key outside declared options",
			{
				answers: {
					urgent: { type: "noul", probability: 0.5 },
					team: { type: "choice", probabilities: { billing: 1 } },
					severity: { type: "score", score: 0 },
				},
			},
		],
		[
			"choice without probabilities",
			{
				answers: {
					urgent: { type: "noul", probability: 0.5 },
					team: { type: "choice", choice: "trading" },
					severity: { type: "score", score: 0 },
				},
			},
		],
		[
			"score beyond the highest level index",
			{
				answers: {
					urgent: { type: "noul", probability: 0.5 },
					team: { type: "choice", probabilities: { trading: 1 } },
					severity: { type: "score", score: 3 },
				},
			},
		],
	])("rejects %s with AI_SCHEMA_MISMATCH", (_name, response) => {
		expect(parseClefAnswers(questions, response as never)).toEqual({
			kind: "FAILED",
			errorCode: "AI_SCHEMA_MISMATCH",
		});
	});
});

describe("ai decision port — openai mapping", () => {
	it("maps questions to the OpenAI array (predicate/choice/score)", () => {
		expect(mapOpenAiQuestions(questions)).toEqual([
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
			{
				type: "score",
				name: "severity",
				instructions: "Sévérité ?",
				levels: [
					{ label: "mineur", description: "mineur" },
					{ label: "majeur", description: "majeur" },
					{ label: "critique", description: "critique" },
				],
			},
		]);
	});

	it("builds the choice record from per-option probabilities when present (gateway/Jev)", () => {
		const parsed = parseOpenAiAnswers(questions, {
			answers: [
				{
					type: "predicate",
					name: "urgent",
					probability: 0.9,
				},
				{
					type: "choice",
					name: "team",
					choice: "trading",
					confidence: 1,
					probabilities: [
						{ value: "trading", probability: 1 },
						{ value: "infra", probability: 0 },
					],
				},
				{ type: "score", name: "severity", score: 0 },
			],
		});
		expect(parsed).toEqual({
			kind: "ANSWERED",
			answers: [
				{ kind: "PREDICATE", id: "urgent", probability: 0.9 },
				{ kind: "CHOICE", id: "team", probabilities: { trading: 1, infra: 0 } },
				{ kind: "SCORE", id: "severity", score: 0 },
			],
		});
	});

	it("rejects a per-option entry outside the declared options", () => {
		const parsed = parseOpenAiAnswers(questions, {
			answers: [
				{ type: "predicate", name: "urgent", probability: 0.9 },
				{
					type: "choice",
					name: "team",
					choice: "trading",
					probabilities: [{ value: "billing", probability: 1 }],
				},
				{ type: "score", name: "severity", score: 0 },
			],
		});
		expect(parsed).toEqual({ kind: "FAILED", errorCode: "AI_SCHEMA_MISMATCH" });
	});

	it("parses answers, mapping choice confidence to the chosen option", () => {
		const parsed = parseOpenAiAnswers(questions, {
			answers: [
				{
					type: "predicate",
					name: "urgent",
					probability: 0.85,
					confidence: 0.9,
				},
				{ type: "choice", name: "team", choice: "infra", confidence: 0.6 },
				{ type: "score", name: "severity", score: 1.4, confidence: 0.7 },
			],
			usage: { input_tokens: 350 },
		});
		expect(parsed).toEqual({
			kind: "ANSWERED",
			answers: [
				{ kind: "PREDICATE", id: "urgent", probability: 0.85 },
				{ kind: "CHOICE", id: "team", probabilities: { infra: 0.6 } },
				{ kind: "SCORE", id: "severity", score: 1.4 },
			],
			inputTokens: 350,
		});
	});

	it("turns any refusal into REFUSED with the concerned ids", () => {
		const parsed = parseOpenAiAnswers(questions, {
			answers: [
				{
					type: "predicate",
					name: "urgent",
					probability: 0.85,
					confidence: 0.9,
				},
				{ type: "refusal", name: "team" },
			],
		});
		expect(parsed).toEqual({ kind: "REFUSED", refusedIds: ["team"] });
	});

	it.each([
		["empty answers", {}],
		[
			"missing answer for a declared question",
			{ answers: [{ type: "predicate", name: "urgent", probability: 0.5 }] },
		],
		[
			"choice outside declared options",
			{
				answers: [
					{ type: "predicate", name: "urgent", probability: 0.5 },
					{ type: "choice", name: "team", choice: "billing" },
					{ type: "score", name: "severity", score: 0 },
				],
			},
		],
		[
			"score beyond the highest level index",
			{
				answers: [
					{ type: "predicate", name: "urgent", probability: 0.5 },
					{ type: "choice", name: "team", choice: "trading" },
					{ type: "score", name: "severity", score: 3 },
				],
			},
		],
	])("rejects %s with AI_SCHEMA_MISMATCH", (_name, response) => {
		expect(parseOpenAiAnswers(questions, response as never)).toEqual({
			kind: "FAILED",
			errorCode: "AI_SCHEMA_MISMATCH",
		});
	});
});

describe("ai decision port — network audit (§7)", () => {
	it("performs no network access from models/", () => {
		const here = (file: string) =>
			readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
		for (const source of [
			"ai-decision-worker.ts",
			"ai-decision-worker.machine.ts",
		]) {
			const code = here(source);
			for (const forbidden of [
				"fetch(",
				"api.cloudflare.com",
				"api.openai.com",
				"env.AI",
				"https://",
			]) {
				expect(
					code.includes(forbidden),
					`${source} must not contain ${forbidden}`,
				).toBe(false);
			}
		}
	});
});

describe("ai decision port — confiance fallback validée (revue PR #27)", () => {
	it("rejette une confiance hors [0, 1] en fallback choice", () => {
		const parsed = parseOpenAiAnswers(questions, {
			answers: [
				{ type: "predicate", name: "urgent", probability: 0.5 },
				{ type: "choice", name: "team", choice: "trading", confidence: 1.2 },
				{ type: "score", name: "severity", score: 0 },
			],
		});
		expect(parsed).toEqual({ kind: "FAILED", errorCode: "AI_SCHEMA_MISMATCH" });
	});
});
