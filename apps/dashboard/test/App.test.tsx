import { LIVE_TRADING_POLICY } from "@dodash/models";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, type AppGateways } from "../src/App.js";
import {
  DashboardRequestError,
  type AgentStateView,
  type CycleView,
  type DashboardGateway,
  type StartConfiguration,
} from "../src/dashboard-api.js";

const stoppedAgent = (): AgentStateView => ({
  enabled: false,
  phase: "stopped",
  updatedAt: Date.UTC(2026, 7, 26, 12),
  configuration: null,
  portfolio: { cash: 10_000, positionQuantity: 0, averagePrice: 0 },
  dailyPnl: 0,
  nextWakeAt: null,
  lastTradeAt: null,
  lastCycle: null,
  indicators: null,
});

const createGateway = (
  overrides: Partial<DashboardGateway> = {},
): DashboardGateway => ({
  loadState: async () => stoppedAgent(),
  loadCycles: async (): Promise<readonly CycleView[]> => [],
  command: async () => stoppedAgent(),
  ...overrides,
});

const gateways = (gateway: DashboardGateway): AppGateways => ({
  createHttp: () => gateway,
  createDemo: () => gateway,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dashboard journey", () => {
  it("exposes the locked access state before connecting", () => {
    render(<App gateways={gateways(createGateway())} />);

    expect(screen.getByRole("heading", { name: "Choisir l’agent" })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Token dashboard").type).toBe(
      "password",
    );
    expect(screen.getByText("VERROUILLÉE")).toBeTruthy();
  });

  it("announces loading while the durable state is pending", async () => {
    const never = new Promise<AgentStateView>(() => undefined);
    render(
      <App
        gateways={gateways(createGateway({ loadState: async () => never }))}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Voir la démo" }));

    expect(screen.getByText("CHARGEMENT")).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Voir la démo" })
        .disabled,
    ).toBe(true);
  });

  it("returns to access with an explicit error after a failed request", async () => {
    const failure = new DashboardRequestError({
      code: "UNAUTHORIZED",
      retryable: false,
    });
    render(
      <App
        gateways={gateways(
          createGateway({ loadState: async () => Promise.reject(failure) }),
        )}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Voir la démo" }));

    expect((await screen.findByRole("alert")).textContent).toContain("UNAUTHORIZED");
    expect(screen.getByText("VERROUILLÉE")).toBeTruthy();
  });

  it("keeps a live start blocked until explicit confirmation", async () => {
    const command = vi.fn<DashboardGateway["command"]>(
      async (_agentName, directCommand, configuration?: StartConfiguration) =>
        directCommand === "start"
          ? {
              ...stoppedAgent(),
              enabled: true,
              phase: "waiting",
              configuration: configuration ?? null,
            }
          : stoppedAgent(),
    );
    render(<App gateways={gateways(createGateway({ command }))} />);

    await userEvent.click(screen.getByRole("button", { name: "Voir la démo" }));
    await screen.findByRole("heading", { name: "Piloter la boucle" });
    await userEvent.selectOptions(screen.getByLabelText("Exécution"), "live");

    const start = screen.getByRole("button", { name: "Démarrer l’agent" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Confirmer en saisissant LIVE"), "LIVE");
    expect((start as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(start);

    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0]?.[1]).toBe("start");
    expect(command.mock.calls[0]?.[2]).toMatchObject({
      executionMode: "live",
      timeframe: LIVE_TRADING_POLICY.timeframe,
    });
  });

  it("requires confirmation before exposing the kill command", async () => {
    const command = vi.fn<DashboardGateway["command"]>(async () => stoppedAgent());
    const active = {
      ...stoppedAgent(),
      enabled: true,
      phase: "waiting" as const,
    };
    render(
      <App
        gateways={gateways(createGateway({ loadState: async () => active, command }))}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Voir la démo" }));
    await userEvent.click(await screen.findByRole("button", { name: "Kill switch" }));

    expect(
      screen.getByRole("alertdialog", { name: "Engager le kill switch ?" }),
    ).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });
});
