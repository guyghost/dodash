import { getNextSnapshot, setup } from "xstate";
export type P7ShadowPhase =
	| "registered"
	| "preflight"
	| "ready"
	| "observing"
	| "suspended"
	| "stopped"
	| "invalid"
	| "assessing"
	| "completed";
export interface P7ShadowAuthority {
	readonly purpose: "LOCAL_PREPARATION" | "PROSPECTIVE";
	readonly campaignId: string;
	readonly sourceProfileId: string;
	readonly codeSha256: string;
	readonly protocolSha256: string;
	readonly registeredAt: number;
	readonly startAt: number;
	readonly endAt: number;
	readonly qualifiedSource: boolean;
	readonly operatorAuthority: string | null;
}
export const p7ShadowLifecycle = setup({
	types: {
		context: {} as Record<string, never>,
		events: {} as {
			type:
				| "PREFLIGHT"
				| "READY"
				| "START"
				| "PROOF_GAP"
				| "STOP"
				| "INVARIANT_BREACH"
				| "PERIOD_ENDED"
				| "ASSESSMENT_COMMITTED";
		},
	},
}).createMachine({
	id: "p7Shadow",
	context: {},
	initial: "registered",
	states: {
		registered: { on: { PREFLIGHT: "preflight", INVARIANT_BREACH: "invalid" } },
		preflight: { on: { READY: "ready", INVARIANT_BREACH: "invalid" } },
		ready: { on: { START: "observing", INVARIANT_BREACH: "invalid" } },
		observing: {
			on: {
				PROOF_GAP: "suspended",
				STOP: "stopped",
				INVARIANT_BREACH: "invalid",
				PERIOD_ENDED: "assessing",
			},
		},
		suspended: {
			on: {
				STOP: "stopped",
				INVARIANT_BREACH: "invalid",
				PERIOD_ENDED: "assessing",
			},
		},
		stopped: { on: { INVARIANT_BREACH: "invalid", PERIOD_ENDED: "assessing" } },
		assessing: {
			on: { ASSESSMENT_COMMITTED: "completed", INVARIANT_BREACH: "invalid" },
		},
		completed: { type: "final" },
		invalid: { type: "final" },
	},
});
export function transitionP7Shadow(
	phase: P7ShadowPhase,
	type: Parameters<typeof p7ShadowLifecycle.transition>[1]["type"],
	authority: P7ShadowAuthority,
	now: number,
	capability: {
		enabled: boolean;
		qualifiedEvidence: boolean;
		operatorAuthority: string | null;
	},
): P7ShadowPhase {
	if (!Number.isSafeInteger(now) || now < authority.registeredAt)
		throw new Error("INVALID_CLOCK");
	if (type === "READY" || type === "START") {
		if (
			authority.purpose !== "PROSPECTIVE" ||
			!capability.enabled ||
			!capability.qualifiedEvidence ||
			!authority.qualifiedSource ||
			!authority.operatorAuthority ||
			capability.operatorAuthority !== authority.operatorAuthority ||
			![authority.codeSha256, authority.protocolSha256].every((h) =>
				/^[a-f0-9]{64}$/.test(h),
			) ||
			authority.registeredAt >= authority.startAt ||
			authority.startAt % 86_400_000 !== 0 ||
			authority.endAt - authority.startAt !== 180 * 86_400_000
		)
			throw new Error("PROSPECTIVE_ACTIVATION_DISABLED");
	}
	if (type === "START" && (now < authority.startAt || now >= authority.endAt))
		throw new Error("START_WINDOW_INVALID");
	if (type === "PERIOD_ENDED" && now < authority.endAt)
		throw new Error("PERIOD_NOT_ENDED");
	const next = getNextSnapshot(
		p7ShadowLifecycle,
		p7ShadowLifecycle.resolveState({ value: phase, context: {} }),
		{ type },
	).value as P7ShadowPhase;
	if (next === phase) throw new Error("INVALID_LIFECYCLE_TRANSITION");
	return next;
}
