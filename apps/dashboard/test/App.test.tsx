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
  delete (globalThis as { ethereum?: unknown }).ethereum;
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

type WalletRequest = { readonly method: string };

const installWalletProvider = (
  responses: Partial<Record<"eth_requestAccounts" | "eth_chainId", unknown>> = {},
  reject?: { code: number },
): { readonly events: Map<string, Set<(payload: unknown) => void>> } => {
  const events = new Map<string, Set<(payload: unknown) => void>>();
  const provider = {
    request: async (args: WalletRequest) => {
      if (reject !== undefined && args.method === "eth_requestAccounts") {
        const rejection = new Error("user rejected") as { code: number };
        rejection.code = reject.code;
        throw rejection;
      }
      return responses[args.method as "eth_requestAccounts"] ?? (args.method === "eth_chainId" ? "0x2105" : []);
    },
    on: (name: string, listener: (payload: unknown) => void) => {
      const set = events.get(name) ?? new Set();
      set.add(listener);
      events.set(name, set);
    },
    removeListener: (name: string, listener: (payload: unknown) => void) => {
      events.get(name)?.delete(listener);
    },
  };
  (globalThis as { ethereum?: unknown }).ethereum = provider;
  return { events };
};

const ADDRESS = "0x1111111111111111111111111111111111111111";

describe("wallet base", () => {
  it("signale l'absence de provider sans lever d'exception", async () => {
    render(<App gateways={gateways(createGateway())} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Connecter le wallet" }),
    );

    expect(screen.getByText("WALLET_PROVIDER_UNAVAILABLE")).toBeTruthy();
  });

  it("connecte le wallet sur Base et verrouille les perpétuels", async () => {
    installWalletProvider({
      eth_requestAccounts: ["0x1111111111111111111111111111111111111111"],
      eth_chainId: "0x2105",
    });
    render(<App gateways={gateways(createGateway())} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Connecter le wallet" }),
    );

    await waitFor(() =>
      expect(screen.getByText("CONNECTÉ · 8453")).toBeTruthy(),
    );
    expect(screen.getByText("0x1111…1111")).toBeTruthy();
    expect(
      screen.getByText("PERPÉTUELS : VERROUILLÉS · ADMISSION FERMÉE"),
    ).toBeTruthy();
  });

  it("affiche un mauvais réseau quand la chaîne n'est pas Base", async () => {
    installWalletProvider({
      eth_requestAccounts: ["0x1111111111111111111111111111111111111111"],
      eth_chainId: "0x1",
    });
    render(<App gateways={gateways(createGateway())} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Connecter le wallet" }),
    );

    await waitFor(() =>
      expect(screen.getByText("MAUVAIS RÉSEAU")).toBeTruthy(),
    );
    expect(screen.getByText("PERPÉTUELS : MAUVAIS RÉSEAU")).toBeTruthy();
  });

  it("convertit un refus utilisateur en erreur typée retryable", async () => {
    installWalletProvider({}, { code: 4001 });
    render(<App gateways={gateways(createGateway())} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Connecter le wallet" }),
    );

    expect(await screen.findByText("WALLET_REQUEST_REJECTED")).toBeTruthy();
  });

  it("revient à hors ligne sur la révocation des comptes", async () => {
    const { events } = installWalletProvider({
      eth_requestAccounts: [ADDRESS],
      eth_chainId: "0x2105",
    });
    render(<App gateways={gateways(createGateway())} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Connecter le wallet" }),
    );
    await screen.findByText("CONNECTÉ · 8453");

    for (const listener of events.get("accountsChanged") ?? []) {
      listener([]);
    }

    await waitFor(() =>
      expect(screen.getByText("PERPÉTUELS : WALLET NON CONNECTÉ")).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Connecter le wallet" })).toBeTruthy();
  });
});

describe("perp order form", () => {
  it("prépare, confirme et affiche l'issue de l'ordre perp", async () => {
    const submitPerpOrder = vi.fn(async (
      _agentName: string,
      body: { readonly clientOrderId: string },
    ) => ({
      status: "SETTLED" as const,
      outcome: "ACCEPTED" as const,
      clientOrderId: body.clientOrderId,
    }));
    const gateway = {
      ...createGateway(),
      submitPerpOrder,
    };
    render(
      <App gateways={{ createHttp: () => gateway, createDemo: () => gateway }} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Voir la démo" }));
    await screen.findByRole("heading", { name: "Piloter la boucle" });

    await userEvent.click(
      screen.getByRole("button", { name: "Préparer l'ordre" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Confirmer BUY/ }),
    );

    await waitFor(() =>
      expect(screen.getByText(/ORDRE ACCEPTED/)).toBeTruthy(),
    );
    expect(submitPerpOrder).toHaveBeenCalledOnce();
    const call = submitPerpOrder.mock.calls[0] as unknown as [
      string,
      { intent: { productId: string; leverage: number }; gate: { dailyPnl: number } },
    ];
    expect(call[1].intent.productId).toBe("BTC-PERP");
    expect(call[1].intent.leverage).toBe(1);
    expect(call[1].gate).toEqual({ dailyPnl: 0 });

    await userEvent.click(screen.getByRole("button", { name: "Nouvel ordre" }));
    expect(
      screen.getByRole("button", { name: "Préparer l'ordre" }),
    ).toBeTruthy();
  });
});
