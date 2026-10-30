/**
 * AI decision gateway adapter (models/ai-decision-worker.md §8).
 *
 * Shell effect: performs the provider decision call through the Vercel AI
 * Gateway (`/v1/decisions`, OpenAI Decisions wire format) and normalizes the
 * response into the port's closed `AiDecisionResult`. The gateway key is
 * injected by the caller (wrangler secret `AI_GATEWAY_KEY`); it never enters
 * the repository nor persisted context (§5). Retries are owned by
 * `aiDecisionWorkerMachine`, never by this adapter.
 *
 * v1 limitation: the gateway input is a plain string; a state carrying
 * images is rejected before the call (transport schema mismatch), the
 * multimodal path belongs to the clef binding.
 */
import {
	type AiDecisionRequest,
	type AiDecisionResult,
	type AiErrorCode,
	type AiParsedDecision,
	type AiProvider,
	mapOpenAiQuestions,
	parseOpenAiAnswers,
	validateAiDecisionRequest,
} from "@dodash/models";
import { z } from "zod";

export const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

/** §8: provider → gateway model id; clef travels through the `env.AI` binding. */
const GATEWAY_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
	jev: "typesafe-ai/jev",
	"openai-decisions": "openai/gpt-6-luna-decisions",
};

const gatewayAnswerSchema = z.object({
	type: z.enum(["predicate", "choice", "score", "refusal"]),
	name: z.string().optional(),
	probability: z.number().optional(),
	choice: z.string().optional(),
	confidence: z.number().optional(),
	score: z.number().optional(),
	// Extension gateway/Jev : probabilités par option d'une réponse choice.
	probabilities: z
		.array(z.object({ value: z.string(), probability: z.number() }))
		.optional(),
});

const gatewayResponseSchema = z.object({
	answers: z.array(gatewayAnswerSchema).min(1),
	usage: z.object({ input_tokens: z.number().optional() }).optional(),
});

export interface AiGatewayDeps {
	readonly gatewayKey: string;
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
	readonly nowMs?: () => number;
}

const failure = (errorCode: AiErrorCode): AiDecisionResult =>
	Object.freeze({ kind: "FAILED", errorCode });

const isAbortLike = (error: unknown): boolean =>
	error instanceof DOMException &&
	(error.name === "TimeoutError" || error.name === "AbortError");

/** v1: plain string input — text, or the JSON state serialized (images unsupported). */
const stateToInput = (state: AiDecisionRequest["state"]): string | null => {
	if (state.images !== undefined && state.images.length > 0) {
		return null;
	}
	if (state.text !== undefined && state.text.length > 0) {
		return state.text;
	}
	if (state.json !== undefined) {
		return JSON.stringify(state.json);
	}
	return null;
};

export const requestGatewayDecision = async (
	provider: AiProvider,
	request: AiDecisionRequest,
	deps: AiGatewayDeps,
): Promise<AiDecisionResult> => {
	const model = GATEWAY_MODEL_BY_PROVIDER[provider];
	if (model === undefined) {
		return failure("AI_PROVIDER_ERROR");
	}
	if (!validateAiDecisionRequest(request).ok) {
		return failure("AI_SCHEMA_MISMATCH");
	}
	const input = stateToInput(request.state);
	if (input === null) {
		return failure("AI_SCHEMA_MISMATCH");
	}
	const nowMs = deps.nowMs ?? Date.now;
	const startedAt = nowMs();
	let response: Response;
	try {
		response = await (deps.fetchImpl ?? fetch)(
			`${deps.baseUrl ?? AI_GATEWAY_BASE_URL}/decisions`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${deps.gatewayKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model,
					input,
					questions: mapOpenAiQuestions(request.questions),
				}),
				signal: AbortSignal.timeout(request.timeoutMs),
			},
		);
	} catch (error) {
		return failure(isAbortLike(error) ? "AI_TIMEOUT" : "AI_PROVIDER_ERROR");
	}
	if (response.status === 429) {
		return failure("AI_QUOTA");
	}
	if (!response.ok) {
		return failure("AI_PROVIDER_ERROR");
	}
	const body: unknown = await response.json().catch(() => null);
	const parsed = gatewayResponseSchema.safeParse(body);
	if (!parsed.success) {
		return failure("AI_SCHEMA_MISMATCH");
	}
	const decision: AiParsedDecision = parseOpenAiAnswers(
		request.questions,
		parsed.data,
	);
	if (decision.kind !== "ANSWERED") {
		return decision;
	}
	const latencyMs = nowMs() - startedAt;
	if (decision.inputTokens === undefined) {
		return { kind: "ANSWERED", answers: decision.answers, latencyMs };
	}
	return {
		kind: "ANSWERED",
		answers: decision.answers,
		latencyMs,
		inputTokens: decision.inputTokens,
	};
};
