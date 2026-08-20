import {
  tradingCycleMachine,
  type TradingCycleContext,
  type TradingCycleEvent,
  type TradingCycleInput,
} from "@dodash/models";
import { createActor } from "xstate";

export interface PersistedTradingMachine {
  readonly value: string;
  readonly context: TradingCycleContext;
}

export interface TradingMachineSession {
  readonly phase: string;
  readonly context: TradingCycleContext;
  readonly record: PersistedTradingMachine;
  send(event: TradingCycleEvent): void;
  stop(): void;
}

const toRecord = (
  snapshot: ReturnType<ReturnType<typeof createActor<typeof tradingCycleMachine>>["getSnapshot"]>,
): PersistedTradingMachine => {
  if (typeof snapshot.value !== "string") {
    throw new Error("Trading cycle must remain a top-level atomic state machine");
  }
  return Object.freeze({
    value: snapshot.value,
    context: structuredClone(snapshot.context),
  });
};

export const createTradingMachineSession = (
  input: TradingCycleInput,
  persisted?: PersistedTradingMachine,
): TradingMachineSession => {
  const normalizedPersisted =
    persisted === undefined
      ? undefined
      : {
          ...persisted,
          context: {
            ...persisted.context,
            lastDecisionCandleClosedAt:
              persisted.context.lastDecisionCandleClosedAt ?? null,
          },
        };
  const restored =
    normalizedPersisted === undefined
      ? undefined
      : tradingCycleMachine.resolveState({
          value: normalizedPersisted.value,
          context: structuredClone(normalizedPersisted.context),
        });
  const actor = createActor(tradingCycleMachine, {
    input,
    ...(restored === undefined ? {} : { snapshot: restored }),
  });
  actor.start();

  return {
    get phase() {
      const value = actor.getSnapshot().value;
      if (typeof value !== "string") {
        throw new Error("Trading cycle entered a non-atomic state");
      }
      return value;
    },
    get context() {
      return actor.getSnapshot().context;
    },
    get record() {
      return toRecord(actor.getSnapshot());
    },
    send(event) {
      actor.send(event);
    },
    stop() {
      actor.stop();
    },
  };
};
