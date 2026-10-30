/**
 * AI decision worker machine (models/ai-decision-worker.md §3).
 *
 * The machine owns no clock and performs no I/O: the shell issues the
 * provider call while `requesting` is active and reports the normalized
 * result as `RESULT`. At most `AI_MAX_RETRIES` retries, on `AI_TIMEOUT` and
 * `AI_PROVIDER_ERROR` only; `failed` is stable and requires `RESET`. The
 * machine emits no business event (INV 1): consumers read the terminal
 * state and translate answers through pure thresholds of their own.
 */
import { assign, setup } from "xstate";
import {
	AI_MAX_RETRIES,
	isRetryableAiErrorCode,
	validateAiDecisionRequest,
} from "./ai-decision-worker.js";
import type {
	AiDecisionWorkerContext,
	AiDecisionWorkerEvent,
} from "./ai-decision-worker.types.js";

const initialContext: AiDecisionWorkerContext = {
	request: null,
	attempts: 0,
	lastResult: null,
	errorCode: null,
};

export const aiDecisionWorkerMachine = setup({
	types: {
		context: {} as AiDecisionWorkerContext,
		events: {} as AiDecisionWorkerEvent,
	},
	guards: {
		requestValid: ({ event }) =>
			event.type === "REQUEST" && validateAiDecisionRequest(event.request).ok,
		answered: ({ event }) =>
			event.type === "RESULT" && event.result.kind === "ANSWERED",
		refused: ({ event }) =>
			event.type === "RESULT" && event.result.kind === "REFUSED",
		retryable: ({ context, event }) =>
			event.type === "RESULT" &&
			event.result.kind === "FAILED" &&
			isRetryableAiErrorCode(event.result.errorCode) &&
			context.attempts <= AI_MAX_RETRIES,
	},
	actions: {
		acceptRequest: assign(({ context, event }) => ({
			request: event.type === "REQUEST" ? event.request : context.request,
			attempts: context.attempts + 1,
			lastResult: null,
			errorCode: null,
		})),
		countRetry: assign(({ context }) => ({ attempts: context.attempts + 1 })),
		recordResult: assign(({ event }) =>
			event.type === "RESULT" ? { lastResult: event.result } : {},
		),
		recordFailure: assign(({ event }) =>
			event.type === "RESULT" && event.result.kind === "FAILED"
				? { lastResult: event.result, errorCode: event.result.errorCode }
				: {},
		),
		markSchemaMismatch: assign(() => ({
			lastResult: { kind: "FAILED", errorCode: "AI_SCHEMA_MISMATCH" } as const,
			errorCode: "AI_SCHEMA_MISMATCH" as const,
		})),
		reset: assign(() => initialContext),
	},
}).createMachine({
	id: "aiDecisionWorker",
	context: initialContext,
	initial: "idle",
	states: {
		idle: {
			on: {
				REQUEST: [
					{
						guard: "requestValid",
						target: "requesting",
						actions: "acceptRequest",
					},
					{ target: "failed", actions: "markSchemaMismatch" },
				],
			},
		},
		requesting: {
			on: {
				RESULT: [
					{ guard: "answered", target: "answered", actions: "recordResult" },
					{ guard: "refused", target: "refused", actions: "recordResult" },
					{
						guard: "retryable",
						target: "requesting",
						actions: ["recordFailure", "countRetry"],
					},
					{ target: "failed", actions: "recordFailure" },
				],
			},
		},
		answered: { type: "final" },
		refused: { type: "final" },
		failed: {
			on: { RESET: { target: "idle", actions: "reset" } },
		},
	},
});
