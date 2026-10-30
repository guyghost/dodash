/**
 * AI decision port — provider-agnostic System One contract
 * (models/ai-decision-worker.md).
 *
 * Pure and network-free: provider calls are effects of the shell
 * (`apps/agent`); this module only validates requests and normalizes
 * questions and answers between the port types and each provider's wire
 * format. No output of this port ever drives a business state transition
 * (INV 1): consumers translate answers through pure thresholds of their own.
 */

/** Providers sharing the System One shape (§1); `jev` is deferred (§2). */
export type AiProvider = "clef" | "openai-decisions" | "jev";

export type AiQuestion =
	| {
			readonly kind: "PREDICATE";
			readonly id: string;
			readonly instructions: string;
	  }
	| {
			readonly kind: "CHOICE";
			readonly id: string;
			readonly instructions: string;
			/** Closed set, ≥ 2 distinct options (§7). */
			readonly options: readonly string[];
	  }
	| {
			readonly kind: "SCORE";
			readonly id: string;
			readonly instructions: string;
			/** Closed ordered set, ≥ 2 distinct levels (§7). */
			readonly levels: readonly string[];
	  };

export type AiAnswer =
	| {
			readonly kind: "PREDICATE";
			readonly id: string;
			readonly probability: number;
	  }
	| {
			readonly kind: "CHOICE";
			readonly id: string;
			/** Probability mass per option; an absent key means "not reported" (review note). */
			readonly probabilities: Readonly<Record<string, number>>;
	  }
	| { readonly kind: "SCORE"; readonly id: string; readonly score: number };

export type AiErrorCode =
	| "AI_TIMEOUT"
	| "AI_REFUSED"
	| "AI_SCHEMA_MISMATCH"
	| "AI_PROVIDER_ERROR"
	| "AI_QUOTA";

export interface AiImage {
	readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
	readonly base64: string;
}

export interface AiState {
	/** Free-form evidence text. */
	readonly text?: string;
	/** Structured evidence, passed through as JSON. */
	readonly json?: unknown;
	/** ≤ `AI_MAX_IMAGES` images (clef contract, §1). */
	readonly images?: readonly AiImage[];
}

export interface AiDecisionRequest {
	readonly provider: AiProvider;
	readonly state: AiState;
	readonly questions: readonly AiQuestion[];
	/** Bounded timeout carried by the machine's `requesting` phase (§3). */
	readonly timeoutMs: number;
}

export type AiDecisionResult =
	| {
			readonly kind: "ANSWERED";
			readonly answers: readonly AiAnswer[];
			readonly latencyMs: number;
			readonly inputTokens?: number;
	  }
	| { readonly kind: "REFUSED"; readonly refusedIds: readonly string[] }
	| { readonly kind: "FAILED"; readonly errorCode: AiErrorCode };

/** Parser output: an `AiDecisionResult` whose `ANSWERED` latency is not yet measured. */
export type AiParsedDecision =
	| {
			readonly kind: "ANSWERED";
			readonly answers: readonly AiAnswer[];
			readonly inputTokens?: number;
	  }
	| { readonly kind: "REFUSED"; readonly refusedIds: readonly string[] }
	| { readonly kind: "FAILED"; readonly errorCode: AiErrorCode };

/** Port bounds: strictest contract across providers (clef: 64 questions, 4 images). */
export const AI_MAX_QUESTIONS = 64;
export const AI_MAX_IMAGES = 4;
/** Retry budget of the machine on `AI_TIMEOUT`/`AI_PROVIDER_ERROR` only (§3). */
export const AI_MAX_RETRIES = 1;

/** Question ids follow the strictest provider contract (clef: ≤ 100 chars). */
const AI_QUESTION_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

const hasDuplicates = (values: readonly string[]): boolean =>
	new Set(values).size !== values.length;

const isProbability = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= 0 &&
	value <= 1;

export type AiRequestValidation =
	| { readonly ok: true }
	| { readonly ok: false; readonly errorCode: AiErrorCode };

/**
 * Rejects out-of-bounds requests before any call (§2): empty or oversized
 * question sets, malformed ids, duplicate ids, closed sets with fewer than
 * two distinct entries, oversized media, or a state without evidence.
 */
export const validateAiDecisionRequest = (
	request: AiDecisionRequest,
): AiRequestValidation => {
	const invalid = {
		ok: false as const,
		errorCode: "AI_SCHEMA_MISMATCH" as const,
	};
	if (
		request.questions.length === 0 ||
		request.questions.length > AI_MAX_QUESTIONS
	)
		return invalid;
	const ids = request.questions.map((question) => question.id);
	if (ids.some((id) => !AI_QUESTION_ID_PATTERN.test(id)) || hasDuplicates(ids))
		return invalid;
	for (const question of request.questions) {
		if (question.kind === "PREDICATE") continue;
		const entries =
			question.kind === "CHOICE" ? question.options : question.levels;
		if (entries.length < 2 || hasDuplicates(entries)) return invalid;
	}
	const { state } = request;
	if (
		(state.text === undefined || state.text.length === 0) &&
		state.json === undefined
	) {
		return invalid;
	}
	if ((state.images?.length ?? 0) > AI_MAX_IMAGES) return invalid;
	if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
		return invalid;
	}
	return { ok: true };
};

/** `AI_TIMEOUT` and `AI_PROVIDER_ERROR` are the only retryable codes (§3). */
export const isRetryableAiErrorCode = (errorCode: AiErrorCode): boolean =>
	errorCode === "AI_TIMEOUT" || errorCode === "AI_PROVIDER_ERROR";

/** clef wire types (`@cf/cloudflare/clef`, §1): `noul`/`choice`/`score`. */
export type ClefQuestionSpec =
	| { readonly type: "noul"; readonly instructions: string }
	| {
			readonly type: "choice";
			readonly instructions: string;
			readonly criteria: Readonly<Record<string, string>>;
	  }
	| {
			readonly type: "score";
			readonly instructions: string;
			readonly criteria: readonly string[];
	  };

export interface ClefAnswerSpec {
	readonly type: "noul" | "choice" | "score";
	readonly probability?: number;
	readonly choice?: string;
	readonly probabilities?: Readonly<Record<string, number>>;
	readonly score?: number;
}

export interface ClefDecisionResponse {
	readonly answers: Readonly<Record<string, ClefAnswerSpec>>;
	readonly usage?: { readonly inputTokens?: number };
}

/** Maps port questions to the clef `questions` record (ids become keys). */
export const mapClefQuestions = (
	questions: readonly AiQuestion[],
): Readonly<Record<string, ClefQuestionSpec>> => {
	const mapped: Record<string, ClefQuestionSpec> = {};
	for (const question of questions) {
		if (question.kind === "PREDICATE") {
			mapped[question.id] = {
				type: "noul",
				instructions: question.instructions,
			};
		} else if (question.kind === "CHOICE") {
			mapped[question.id] = {
				type: "choice",
				instructions: question.instructions,
				criteria: Object.fromEntries(
					question.options.map((option) => [option, option]),
				),
			};
		} else {
			mapped[question.id] = {
				type: "score",
				instructions: question.instructions,
				criteria: question.levels,
			};
		}
	}
	return Object.freeze(mapped);
};

const schemaMismatch: AiParsedDecision = Object.freeze({
	kind: "FAILED",
	errorCode: "AI_SCHEMA_MISMATCH",
});

/**
 * Normalizes a clef response against the declared questions: every id must be
 * answered, probabilities must lie in [0, 1], choice keys must belong to the
 * declared options, and scores to `[0, levels.length - 1]`.
 */
export const parseClefAnswers = (
	questions: readonly AiQuestion[],
	response: ClefDecisionResponse,
): AiParsedDecision => {
	const answers: AiAnswer[] = [];
	for (const question of questions) {
		const answer = response.answers[question.id];
		if (answer === undefined || answer.type === undefined)
			return schemaMismatch;
		if (question.kind === "PREDICATE") {
			if (answer.type !== "noul" || !isProbability(answer.probability))
				return schemaMismatch;
			answers.push({
				kind: "PREDICATE",
				id: question.id,
				probability: answer.probability,
			});
		} else if (question.kind === "CHOICE") {
			const probabilities = answer.probabilities;
			if (
				answer.type !== "choice" ||
				probabilities === undefined ||
				Object.keys(probabilities).length === 0
			) {
				return schemaMismatch;
			}
			const normalized: Record<string, number> = {};
			for (const [option, probability] of Object.entries(probabilities)) {
				if (!question.options.includes(option) || !isProbability(probability))
					return schemaMismatch;
				normalized[option] = probability;
			}
			answers.push({
				kind: "CHOICE",
				id: question.id,
				probabilities: Object.freeze(normalized),
			});
		} else {
			const score = answer.score;
			if (
				answer.type !== "score" ||
				typeof score !== "number" ||
				!Number.isFinite(score) ||
				score < 0 ||
				score > question.levels.length - 1
			) {
				return schemaMismatch;
			}
			answers.push({ kind: "SCORE", id: question.id, score });
		}
	}
	const inputTokens = response.usage?.inputTokens;
	return Object.freeze(
		inputTokens === undefined
			? { kind: "ANSWERED", answers: Object.freeze(answers) }
			: { kind: "ANSWERED", answers: Object.freeze(answers), inputTokens },
	);
};

/** OpenAI Decisions wire types (`gpt-6-luna`, §1). */
export type OpenAiDecisionQuestionSpec =
	| {
			readonly type: "predicate";
			readonly name: string;
			readonly instructions: string;
	  }
	| {
			readonly type: "choice";
			readonly name: string;
			readonly instructions: string;
			readonly choices: readonly {
				readonly value: string;
				readonly description: string;
			}[];
	  }
	| {
			readonly type: "score";
			readonly name: string;
			readonly instructions: string;
			readonly levels: readonly {
				readonly label: string;
				readonly description: string;
			}[];
	  };

export interface OpenAiDecisionAnswerSpec {
	readonly type: "predicate" | "choice" | "score" | "refusal";
	readonly name?: string;
	readonly probability?: number;
	readonly choice?: string;
	readonly confidence?: number;
	readonly score?: number;
}

export interface OpenAiDecisionResponse {
	readonly answers?: readonly OpenAiDecisionAnswerSpec[];
	readonly usage?: { readonly input_tokens?: number };
}

/** Maps port questions to the OpenAI Decisions `questions` array. */
export const mapOpenAiQuestions = (
	questions: readonly AiQuestion[],
): readonly OpenAiDecisionQuestionSpec[] =>
	Object.freeze(
		questions.map((question): OpenAiDecisionQuestionSpec => {
			if (question.kind === "PREDICATE") {
				return {
					type: "predicate",
					name: question.id,
					instructions: question.instructions,
				};
			}
			if (question.kind === "CHOICE") {
				return {
					type: "choice",
					name: question.id,
					instructions: question.instructions,
					choices: question.options.map((option) => ({
						value: option,
						description: option,
					})),
				};
			}
			return {
				type: "score",
				name: question.id,
				instructions: question.instructions,
				levels: question.levels.map((level) => ({
					label: level,
					description: level,
				})),
			};
		}),
	);

/**
 * Normalizes an OpenAI Decisions response. A refusal is an answer (INV 3):
 * any refused question returns `REFUSED` with the concerned ids and no
 * partial answer is consumed. OpenAI reports the chosen value and its
 * confidence, not per-option probabilities: the normalized record carries
 * `{ [chosen]: confidence }` (review note).
 */
export const parseOpenAiAnswers = (
	questions: readonly AiQuestion[],
	response: OpenAiDecisionResponse,
): AiParsedDecision => {
	if (!Array.isArray(response.answers) || response.answers.length === 0)
		return schemaMismatch;
	const refusedIds = response.answers
		.filter((answer) => answer.type === "refusal")
		.map((answer) => answer.name ?? "");
	if (refusedIds.length > 0) {
		return Object.freeze({
			kind: "REFUSED",
			refusedIds: Object.freeze(refusedIds),
		});
	}
	const byId = new Map(
		response.answers.map((answer) => [answer.name ?? "", answer] as const),
	);
	const answers: AiAnswer[] = [];
	for (const question of questions) {
		const answer = byId.get(question.id);
		if (answer === undefined) return schemaMismatch;
		if (question.kind === "PREDICATE") {
			if (answer.type !== "predicate" || !isProbability(answer.probability))
				return schemaMismatch;
			answers.push({
				kind: "PREDICATE",
				id: question.id,
				probability: answer.probability,
			});
		} else if (question.kind === "CHOICE") {
			if (
				answer.type !== "choice" ||
				answer.choice === undefined ||
				!question.options.includes(answer.choice)
			) {
				return schemaMismatch;
			}
			answers.push({
				kind: "CHOICE",
				id: question.id,
				probabilities: Object.freeze({
					[answer.choice]: answer.confidence ?? 1,
				}),
			});
		} else {
			const score = answer.score;
			if (
				answer.type !== "score" ||
				typeof score !== "number" ||
				!Number.isFinite(score) ||
				score < 0 ||
				score > question.levels.length - 1
			) {
				return schemaMismatch;
			}
			answers.push({ kind: "SCORE", id: question.id, score });
		}
	}
	const inputTokens = response.usage?.input_tokens;
	return Object.freeze(
		inputTokens === undefined
			? { kind: "ANSWERED", answers: Object.freeze(answers) }
			: { kind: "ANSWERED", answers: Object.freeze(answers), inputTokens },
	);
};
