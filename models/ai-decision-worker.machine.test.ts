import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import type { AiDecisionRequest } from "./ai-decision-worker.js";
import { aiDecisionWorkerMachine } from "./ai-decision-worker.machine.js";
import type { AiDecisionWorkerEvent } from "./ai-decision-worker.types.js";

const request: AiDecisionRequest = {
	provider: "clef",
	state: { text: "Cycle terminé sans décision pour la bougie 00:00." },
	questions: [
		{
			kind: "PREDICATE",
			id: "urgent",
			instructions: "L'absence de décision est-elle urgente ?",
		},
		{
			kind: "CHOICE",
			id: "team",
			instructions: "Quelle équipe traiter ?",
			options: ["trading", "infra"],
		},
		{
			kind: "SCORE",
			id: "severity",
			instructions: "Sévérité ?",
			levels: ["mineur", "majeur", "critique"],
		},
	],
	timeoutMs: 500,
};

const failure = (
	errorCode:
		| "AI_TIMEOUT"
		| "AI_PROVIDER_ERROR"
		| "AI_QUOTA"
		| "AI_SCHEMA_MISMATCH",
) => ({ kind: "FAILED", errorCode }) as const;
const answered = {
	kind: "ANSWERED",
	answers: [{ kind: "PREDICATE", id: "urgent", probability: 0.8 }],
	latencyMs: 120,
} as const;

describe("ai decision worker machine", () => {
	it("answers after a single call", () => {
		const actor = createActor(aiDecisionWorkerMachine).start();
		actor.send({ type: "REQUEST", request });
		expect(actor.getSnapshot().value).toBe("requesting");
		expect(actor.getSnapshot().context.attempts).toBe(1);
		actor.send({ type: "RESULT", result: answered });
		expect(actor.getSnapshot().value).toBe("answered");
		expect(actor.getSnapshot().context.lastResult).toEqual(answered);
		actor.stop();
	});

	it("retries a timeout once, then fails stably until RESET", () => {
		const actor = createActor(aiDecisionWorkerMachine).start();
		actor.send({ type: "REQUEST", request });
		actor.send({ type: "RESULT", result: failure("AI_TIMEOUT") });
		expect(actor.getSnapshot().value).toBe("requesting");
		expect(actor.getSnapshot().context.attempts).toBe(2);
		actor.send({ type: "RESULT", result: failure("AI_TIMEOUT") });
		expect(actor.getSnapshot().value).toBe("failed");
		expect(actor.getSnapshot().context.errorCode).toBe("AI_TIMEOUT");
		actor.send({ type: "RESULT", result: answered });
		expect(actor.getSnapshot().value).toBe("failed");
		actor.send({ type: "RESET" });
		expect(actor.getSnapshot().value).toBe("idle");
		expect(actor.getSnapshot().context.attempts).toBe(0);
		actor.stop();
	});

	it("recovers after a single retryable provider error", () => {
		const actor = createActor(aiDecisionWorkerMachine).start();
		actor.send({ type: "REQUEST", request });
		actor.send({ type: "RESULT", result: failure("AI_PROVIDER_ERROR") });
		expect(actor.getSnapshot().value).toBe("requesting");
		actor.send({ type: "RESULT", result: answered });
		expect(actor.getSnapshot().value).toBe("answered");
		actor.stop();
	});

	it("never retries a quota error", () => {
		const actor = createActor(aiDecisionWorkerMachine).start();
		actor.send({ type: "REQUEST", request });
		actor.send({ type: "RESULT", result: failure("AI_QUOTA") });
		expect(actor.getSnapshot().value).toBe("failed");
		expect(actor.getSnapshot().context.attempts).toBe(1);
		actor.send({ type: "RESULT", result: answered });
		expect(actor.getSnapshot().value).toBe("failed");
		actor.stop();
	});

	it("rejects an invalid request before any provider call", () => {
		const actor = createActor(aiDecisionWorkerMachine).start();
		actor.send({ type: "REQUEST", request: { ...request, questions: [] } });
		expect(actor.getSnapshot().value).toBe("failed");
		expect(actor.getSnapshot().context.errorCode).toBe("AI_SCHEMA_MISMATCH");
		expect(actor.getSnapshot().context.attempts).toBe(0);
		actor.stop();
	});

	it("treats a refusal as a terminal answer, never a failure", () => {
		const actor = createActor(aiDecisionWorkerMachine).start();
		actor.send({ type: "REQUEST", request });
		actor.send({
			type: "RESULT",
			result: { kind: "REFUSED", refusedIds: ["team"] },
		});
		expect(actor.getSnapshot().value).toBe("refused");
		expect(actor.getSnapshot().context.errorCode).toBeNull();
		actor.stop();
	});

	it("emits no business events: results stay within the closed port kinds", () => {
		const observedKinds: string[] = [];
		const actor = createActor(aiDecisionWorkerMachine).start();
		actor.subscribe((snapshot) => {
			const result = snapshot.context.lastResult;
			if (result !== null) observedKinds.push(result.kind);
		});
		actor.send({ type: "REQUEST", request });
		actor.send({ type: "RESULT", result: failure("AI_TIMEOUT") });
		actor.send({ type: "RESULT", result: failure("AI_TIMEOUT") });
		actor.send({ type: "RESET" });
		// A trading event is not part of the closed event set: it changes nothing.
		actor.send({
			type: "INDICATORS_COMPUTED",
		} as unknown as AiDecisionWorkerEvent);
		expect(actor.getSnapshot().value).toBe("idle");
		expect(
			observedKinds.every((kind) =>
				["ANSWERED", "REFUSED", "FAILED"].includes(kind),
			),
		).toBe(true);
		actor.stop();
	});
});
