import type {
	AiDecisionRequest,
	AiDecisionResult,
	AiErrorCode,
} from "./ai-decision-worker.js";

export interface AiDecisionWorkerContext {
	/** Request accepted by the last `REQUEST`; carries the bounded `timeoutMs` (§3). */
	readonly request: AiDecisionRequest | null;
	/** Number of provider calls issued (first call plus retries). */
	readonly attempts: number;
	/** Last provider result, as normalized by the pure port. */
	readonly lastResult: AiDecisionResult | null;
	/** Terminal error code once `failed` is reached; null otherwise. */
	readonly errorCode: AiErrorCode | null;
}

export type AiDecisionWorkerEvent =
	| { readonly type: "REQUEST"; readonly request: AiDecisionRequest }
	| { readonly type: "RESULT"; readonly result: AiDecisionResult }
	| { readonly type: "RESET" };
