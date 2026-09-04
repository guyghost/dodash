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
  type PnlHistoryView,
  type PortfolioSummaryView,
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
  portfolioSummary: singleProductSummary(),
  indicators: null,
});

const emptyPnlHistory = (): PnlHistoryView => ({
  equityCurve: [],
  cycles: [],
  openPosition: null,
  protection: null,
});

const singleProductSummary = (): PortfolioSummaryView =>
  Object.freeze({ kind: "single-product" });

const portfolioSummary = (): PortfolioSummaryView =>
  Object.freeze({
    kind: "portfolio",
    phase: "running",
    killSwitchActive: false,
    products: [
      Object.freeze({
        productId: "BTC-USD",
        phase: "waiting",
        status: "running" as const,
        cash: 5_000,
        positionQuantity: 0.1,
        averagePrice: 60_000,
        marketPrice: 62_000,
        grossExposure: 6_200,
        maxGrossExposure: 20_000,
        dailyPnl: 42.5,
        lastCycle: Object.freeze({
          cycleId: "cycle-1",
          triggeredAt: Date.UTC(2026, 7, 26, 11),
          completedAt: Date.UTC(2026, 7, 26, 11, 1),
          outcome: "ORDER_CONFIRMED",
          marketPrice: 62_000,
        }),
      }),
      Object.freeze({
        productId: "ETH-USD",
        phase: "halted",
        status: "halted" as const,
        cash: 1_000,
        positionQuantity: 0,
        averagePrice: 0,
        marketPrice: null,
        grossExposure: 0,
        maxGrossExposure: 12_000,
        dailyPnl: -10,
        lastCycle: null,
      }),
    ],
    consolidated: Object.freeze({
      grossExposure: 6_200,
      maxGrossExposure: 30_000,
      dailyPnl: 32.5,
      maxDailyLoss: 1_500,
    }),
  });

const createGateway = (
  overrides: Partial<DashboardGateway> = {},
): DashboardGateway => ({
  loadState: async () => stoppedAgent(),
  loadCycles: async (): Promise<readonly CycleView[]> => [],
  loadPnlHistory: async () => emptyPnlHistory(),
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

  it("renders the read-only pnl projection with protection badges", async () => {
    const startedAt = Date.UTC(2026, 7, 26, 12);
    const active = {
      ...stoppedAgent(),
      enabled: true,
      phase: "waiting" as const,
    };
    const pnlHistory: PnlHistoryView = {
      equityCurve: [
        { t: startedAt - 600_000, equity: 6_401.5 },
        { t: startedAt - 300_000, equity: 6_501.5 },
        { t: startedAt, equity: 6_611.5 },
      ],
      cycles: [
        {
          cycleId: "cycle-buy",
          triggeredAt: startedAt - 300_000,
          completedAt: startedAt - 296_000,
          outcome: "ORDER_CONFIRMED",
          marketPrice: 60_000,
          side: "BUY",
          quantity: 0.1,
          fillPrice: 60_060,
          fee: 1.5,
          realizedPnl: null,
          slippageBps: 10,
        },
        {
          cycleId: "cycle-hold",
          triggeredAt: startedAt,
          completedAt: null,
          outcome: "NO_ACTION",
          marketPrice: 61_000,
          side: null,
          quantity: null,
          fillPrice: null,
          fee: null,
          realizedPnl: null,
          slippageBps: null,
        },
      ],
      openPosition: { quantity: 0.1, averagePrice: 60_098.5 },
      protection: {
        stopLossPrice: 58_000,
        takeProfitPrice: 63_000,
        protectiveOrderConfirmed: true,
      },
    };
    render(
      <App
        gateways={gateways(
          createGateway({
            loadState: async () => active,
            loadPnlHistory: async () => pnlHistory,
          }),
        )}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Voir la démo" }));
    await screen.findByRole("heading", { name: "Piloter la boucle" });

    expect(screen.getByText("PERFORMANCE")).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Position et protections" }).textContent,
    ).toContain("STOP 58\u202f000,00\u00a0$US");
    expect(
      screen.getByRole("group", { name: "Position et protections" }).textContent,
    ).toContain("TAKE-PROFIT 63\u202f000,00\u00a0$US");
    expect(screen.getByRole("img", { name: "Courbe d’équité" })).toBeTruthy();
    expect(screen.getByText("cycle-buy")).toBeTruthy();
    expect(screen.getByText("Slippage")).toBeTruthy();
    expect(screen.getByText("+10,00 bps")).toBeTruthy();
  });

  it("shows an unprotected open position as fail-closed", async () => {
    const active = {
      ...stoppedAgent(),
      enabled: true,
      phase: "waiting" as const,
    };
    const pnlHistory: PnlHistoryView = {
      equityCurve: [],
      cycles: [],
      openPosition: { quantity: 0.1, averagePrice: 60_098.5 },
      protection: null,
    };
    render(
      <App
        gateways={gateways(
          createGateway({
            loadState: async () => active,
            loadPnlHistory: async () => pnlHistory,
          }),
        )}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Voir la démo" }));
    await screen.findByRole("heading", { name: "Piloter la boucle" });

    expect(screen.getByText("NON PROTÉGÉ")).toBeTruthy();
    expect(screen.getByText("Aucun point d’équité.")).toBeTruthy();
  });

  it("renders the read-only portfolio view with quiescent products visible", async () => {
    const active = {
      ...stoppedAgent(),
      enabled: true,
      phase: "waiting" as const,
      // dao #34 : la hiérarchie portefeuille est portée par l'état `/state`.
      portfolioSummary: portfolioSummary(),
    };
    render(
      <App gateways={gateways(createGateway({ loadState: async () => active }))} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Voir la démo" }));
    await screen.findByRole("heading", { name: "Piloter la boucle" });

    expect(screen.getByText("PORTEFEUILLE")).toBeTruthy();
    // Produit actif : phase machine et exposition vs plafond affichées.
    expect(screen.getByText("BTC-USD")).toBeTruthy();
    expect(screen.getByText("ACTIF")).toBeTruthy();
    expect(screen.getAllByText("EXPOSITION").length).toBe(2);
    // Produit quiescent (INV-P3) : visible, jamais masqué.
    expect(screen.getByText("ETH-USD")).toBeTruthy();
    expect(screen.getByText("SUSPENDU")).toBeTruthy();
    // Agrégat consolidé : garde-fous côte à côte, kill switch au repos.
    expect(screen.getByText("Garde-fous du portefeuille")).toBeTruthy();
    expect(screen.getByText("EXPOSITION CONSOLIDÉE")).toBeTruthy();
    expect(screen.getByText("PLAFOND PERTE JOUR")).toBeTruthy();
    expect(screen.queryByText("KILL SWITCH ENGAGÉ")).toBeNull();
    expect(screen.getAllByText(/Dernier cycle :/).length).toBe(2);
  });

  it("keeps the mono-product screen unchanged for a single-product answer", async () => {
    const active = {
      ...stoppedAgent(),
      enabled: true,
      phase: "waiting" as const,
    };
    render(
      <App gateways={gateways(createGateway({ loadState: async () => active }))} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Voir la démo" }));
    await screen.findByRole("heading", { name: "Piloter la boucle" });

    expect(screen.queryByText("PORTEFEUILLE")).toBeNull();
    expect(screen.queryByText("Garde-fous du portefeuille")).toBeNull();
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
