import { assign, setup } from "xstate";

export type MarketProbeProvider = "coinbase-advanced" | "coinbase-exchange" | "hyperliquid" | "dydx";
export interface MarketProbeInput {
  readonly enabled: boolean;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly requestCount: number;
}
export const isMarketProbeWindowOpen = (input: MarketProbeInput, now: number): boolean =>
  input.enabled && input.requestCount === 15 &&
  [input.startedAt, input.expiresAt, now].every((n) => Number.isSafeInteger(n) && n >= 0) &&
  input.startedAt <= now && now < input.expiresAt &&
  input.expiresAt - input.startedAt <= 86_400_000;

export const marketSourceProbeMachine = setup({
  types: {
    input: {} as MarketProbeInput,
    context: {} as MarketProbeInput & { completed: number; blockedProviders: readonly MarketProbeProvider[] },
    events: {} as { type: "START"; now: number } | { type: "RESULT"; provider: MarketProbeProvider; status: number | null } | { type: "EXPIRE" },
  },
  guards: {
    canStart: ({ context, event }) => event.type === "START" && isMarketProbeWindowOpen(context, event.now),
    completed: ({ context }) => context.completed >= context.requestCount,
  },
  actions: {
    recordResult: assign(({ context, event }) => event.type !== "RESULT" ? {} : ({
      completed: context.completed + 1,
      blockedProviders: event.status === 429 && !context.blockedProviders.includes(event.provider)
        ? [...context.blockedProviders, event.provider] : context.blockedProviders,
    })),
  },
}).createMachine({
  id: "marketSourceProbe",
  context: ({ input }) => ({ ...input, completed: 0, blockedProviders: [] }),
  initial: "ready",
  states: {
    ready: { on: { START: [{ guard: "canStart", target: "running" }, { target: "inactive" }] } },
    running: { always: { guard: "completed", target: "completed" }, on: {
      RESULT: { actions: "recordResult" }, EXPIRE: "inactive",
    } },
    completed: { type: "final" },
    inactive: { type: "final" },
  },
});
