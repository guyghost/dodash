/*
  THESIS: Chrono-synoptic telemetry console for autonomous trading loops, refusing the editorial brochure/card-grid dashboard default.
  OWN-WORLD: Obsidian #0b0f14 ground, gunmetal #10161f/#151d28 instrument bays, 1px #243142 hairlines, amber #f59e0b command accent, emerald #10b981 fills, crimson #ef4444 risk guards, tabular-nums monospace telemetry.
  STORY: The operator sees live loop health, open position protection (Stop-Mark-TP), equity waveform, and real-time trade fills in one glance, and commands tick/stop/kill safely.
  FIRST VIEWPORT: Top telemetry bar with live wake countdown and refresh selector; 3-column synoptic deck (Left: Agent state, Stop-Mark-TP gauge, Loop controls; Center: Equity waveform & Live Trade Blotter; Right: 7-stage XState pipeline & Prolog indicators).
  FORM: NASA/SpaceX Flight Director Loop Console, candidate #7 on ordered list, seed key 65c7e41e. Raised with Split-Flap Row Discipline (signals-instruments-split-flap-concourse), Hairline Module Mosaic (japanese-high-density-web), Cell-Mark State Encoding (rw-timetable-slide-rack), Waveform Line Dominance (brand-identity-canon-saville-catalog-sleeve).
  FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
*/
import {
  baseWalletSessionMachine,
  BASE_MAINNET_CHAIN_ID,
  dashboardSessionMachine,
  HYPERLIQUID_PERP_POLICY,
  LIVE_TRADING_POLICY,
  LIVE_TRADING_PRODUCTS,
  perpOrderUiMachine,
  resolvePerpTradingCapability,
  type DashboardDirectCommand,
  type DashboardError,
  type DashboardRemotePhase,
  type PerpOrderFormDraft,
  type PerpRefusalCode,
  type PerpTradingCapability,
} from "@dodash/models";
import { createActor, type SnapshotFrom } from "xstate";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  BaseWalletRequestError,
  connectBaseWallet,
  findInjectedBaseWalletProvider,
  parseHexChainId,
  subscribeBaseWallet,
} from "./base-wallet.js";
import {
  DashboardRequestError,
  createStartConfiguration,
  createHttpGateway,
  type AgentStateView,
  type CycleView,
  type DashboardGateway,
  type PnlHistoryView,
  type PortfolioProductStatusView,
  type PortfolioSummaryView,
  type StartConfiguration,
} from "./dashboard-api.js";
import { createDemoGateway } from "./demo-gateway.js";

const PIPELINE = [
  { phase: "fetchingMarketData", label: "Marché", color: "teal" },
  { phase: "computingIndicators", label: "Indicateurs", color: "purple" },
  { phase: "evaluatingStrategies", label: "Stratégies", color: "green" },
  { phase: "allocating", label: "Allocation", color: "green" },
  { phase: "checkingRisk", label: "Risque", color: "red" },
  { phase: "submittingOrder", label: "Exécution", color: "red" },
  { phase: "persisting", label: "Persistance", color: "blue" },
] as const;

const permissions = Object.freeze({ canControl: true, canTrade: true });
const money = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const quantity = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 8 });
const compactDate = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const phaseLabel = (phase: DashboardRemotePhase | null): string =>
  phase === null
    ? "hors ligne"
    : phase.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

const toDashboardError = (error: unknown): DashboardError =>
  error instanceof DashboardRequestError
    ? error.dashboardError
    : { code: "REQUEST_FAILED", retryable: true };

const outcomeClass = (outcome: string): string => {
  if (outcome === "ORDER_CONFIRMED") return "positive";
  if (outcome === "RISK_REJECTED" || outcome === "FAILED") return "negative";
  return "neutral";
};

const outcomeLabel = (outcome: string): string => {
  if (outcome === "ORDER_CONFIRMED") return "Ordre exécuté";
  if (outcome === "NO_ACTION") return "Aucun signal";
  if (outcome === "RISK_REJECTED") return "Risque bloqué";
  if (outcome === "FAILED") return "Échec";
  if (outcome === "DECISION_WINDOW_MISSED") return "Fenêtre manquée";
  return outcome;
};

const describeRsiZone = (rsi: number): { readonly label: string; readonly tone: string } => {
  if (rsi < 30) return { label: "Survente (< 30)", tone: "positive" };
  if (rsi > 70) return { label: "Surachat (> 70)", tone: "negative" };
  return { label: "Neutre (30–70)", tone: "neutral" };
};

const describeLatestDecision = (params: {
  readonly enabled: boolean;
  readonly productId: string;
  readonly outcome: string | null;
  readonly price: number | null;
  readonly indicators: AgentStateView["indicators"];
  readonly nextWakeAt: number | null;
  readonly nowMs: number;
}): {
  readonly badge: string;
  readonly tone: "positive" | "negative" | "neutral";
  readonly headline: string;
  readonly explanation: string;
} => {
  const priceText = params.price === null ? "" : ` (${money.format(params.price)})`;
  const rsiNote =
    params.indicators === null
      ? "Indicateurs en cours de calcul."
      : `RSI à ${params.indicators.rsi.toFixed(1)} (${describeRsiZone(params.indicators.rsi).label}) · Tendance ${params.indicators.emaFast >= params.indicators.emaSlow ? "haussière" : "baissière"} (EMA ${money.format(params.indicators.emaFast)} vs ${money.format(params.indicators.emaSlow)}).`;

  if (!params.enabled) {
    return {
      badge: "En pause",
      tone: "neutral",
      headline: `Agent arrêté sur ${params.productId}${priceText}`,
      explanation: "La boucle automatique est en pause. Aucun ordre ne sera placé tant qu’elle n’est pas relancée.",
    };
  }
  if (params.outcome === "ORDER_CONFIRMED") {
    return {
      badge: "Trade exécuté",
      tone: "positive",
      headline: `Ordre confirmé sur ${params.productId}${priceText}`,
      explanation: `${rsiNote} Un signal validé par le module de risque vient d’être exécuté.`,
    };
  }
  if (params.outcome === "RISK_REJECTED") {
    return {
      badge: "Protégé",
      tone: "negative",
      headline: `Signal bloqué par le garde-fou risque sur ${params.productId}${priceText}`,
      explanation: `${rsiNote} Le modèle de risque a refusé la prise de position pour protéger le capital.`,
    };
  }
  if (params.outcome === "FAILED") {
    return {
      badge: "Incident",
      tone: "negative",
      headline: `Dernier cycle en échec sur ${params.productId}`,
      explanation: "Le dernier cycle a rencontré une erreur technique. L’agent retentera automatiquement au prochain réveil.",
    };
  }
  const countdown = formatCountdown(params.nextWakeAt, params.nowMs);
  return {
    badge: "En veille active",
    tone: "neutral",
    headline: `En attente sur ${params.productId}${priceText}`,
    explanation: `${rsiNote} Aucun signal d’entrée/sortie sur la dernière bougie${countdown === "—" ? "" : ` · Prochaine analyse dans ${countdown.replace("T-", "")}`}.`,
  };
};

const signedClass = (value: number): string =>
  value >= 0 ? "pnl-positive" : "pnl-negative";

const bps = new Intl.NumberFormat("fr-FR", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const portfolioStatusLabel = (status: PortfolioProductStatusView): string =>
  status === "running"
    ? "ACTIF"
    : status === "stopped"
      ? "ARRÊTÉ"
      : status === "halted"
        ? "SUSPENDU"
        : "EN ÉCHEC";

const equityGeometry = (
  points: readonly { readonly t: number; readonly equity: number }[],
): {
  readonly line: string;
  readonly area: string;
  readonly lastPoint: { readonly x: number; readonly y: number } | null;
} => {
  if (points.length < 2) return { line: "", area: "", lastPoint: null };
  const times = points.map((point) => point.t);
  const equities = points.map((point) => point.equity);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const eMin = Math.min(...equities);
  const eMax = Math.max(...equities);
  const width = 600;
  const height = 160;
  const spanT = Math.max(1, tMax - tMin);
  const spanE = Math.max(Number.EPSILON, eMax - eMin);
  const coords = points.map((point) => {
    const x = ((point.t - tMin) / spanT) * (width - 16) + 8;
    const y = height - ((point.equity - eMin) / spanE) * (height - 28) - 14;
    return { x, y };
  });
  const line = coords
    .map((pt, index) => `${index === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ");
  const first = coords[0];
  const last = coords.at(-1) ?? null;
  const area =
    first !== undefined && last !== null
      ? `${line} L${last.x.toFixed(1)},${height} L${first.x.toFixed(1)},${height} Z`
      : "";
  return { line, area, lastPoint: last };
};

const formatCountdown = (nextWakeAt: number | null, nowMs: number): string => {
  if (nextWakeAt === null) return "—";
  const remainingSec = Math.max(0, Math.round((nextWakeAt - nowMs) / 1_000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  return `T-${String(mins).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
};

function Metric({
  label,
  value,
  accent,
}: {
  readonly label: string;
  readonly value: string;
  readonly accent?: string;
}) {
  return (
    <div className={`metric ${accent ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const capabilityLabel = (capability: PerpTradingCapability): string => {
  if (capability.status === "APPROVED") {
    return `PERPÉTUELS OUVERTS · ${capability.venue.toUpperCase()}`;
  }
  if (capability.reason === "WALLET_NOT_CONNECTED") return "PERPÉTUELS : WALLET NON CONNECTÉ";
  if (capability.reason === "WRONG_CHAIN") return "PERPÉTUELS : MAUVAIS RÉSEAU";
  return "PERPÉTUELS : VERROUILLÉS · ADMISSION FERMÉE";
};

const shortAddress = (address: string): string =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

function BaseWalletCard({
  snapshot,
  onConnect,
  onDisconnect,
}: {
  readonly snapshot: SnapshotFrom<typeof baseWalletSessionMachine>;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
}) {
  const { account, lastError } = snapshot.context;
  const capability = resolvePerpTradingCapability(account);
  const connectedOnBase =
    snapshot.value === "connected" &&
    account !== null &&
    account.chainId === BASE_MAINNET_CHAIN_ID;
  const badge =
    snapshot.value === "connecting"
      ? "CONNEXION"
      : snapshot.value === "connected" && connectedOnBase
        ? "CONNECTÉ · 8453"
        : snapshot.value === "wrongChain"
          ? "MAUVAIS RÉSEAU"
          : snapshot.value === "failed"
            ? "ÉCHEC"
            : "HORS LIGNE";
  return (
    <article className="paper-card wallet-card">
      <h2>Session wallet</h2>
      <span className={`phase-badge ${connectedOnBase ? "online" : "offline"}`}>
        {badge}
      </span>
      {account === null ? (
        <p>Signature locale sur Base (`eip155:8453`).</p>
      ) : (
        <p className="agent-meta">
          <code>{shortAddress(account.address)}</code> ·{" "}
          {account.chainId === BASE_MAINNET_CHAIN_ID
            ? "Base mainnet"
            : `Chaîne ${account.chainId}`}
        </p>
      )}
      <span className="telemetry-pill" aria-live="polite">
        {capabilityLabel(capability)}
      </span>
      {lastError !== null && (
        <p className="error-note" role="alert">
          {lastError.code}
        </p>
      )}
      {snapshot.value === "failed" || snapshot.value === "disconnected" ? (
        <div className="button-row">
          <button className="button secondary" type="button" onClick={onConnect}>
            {snapshot.value === "failed"
              ? "Réessayer la connexion"
              : "Connecter le wallet"}
          </button>
        </div>
      ) : (
        <div className="button-row">
          <button className="text-button" type="button" onClick={onDisconnect}>
            Déconnecter le wallet
          </button>
        </div>
      )}
    </article>
  );
}

export interface AppGateways {
  readonly createHttp: typeof createHttpGateway;
  readonly createDemo: typeof createDemoGateway;
}

const defaultGateways: AppGateways = Object.freeze({
  createHttp: createHttpGateway,
  createDemo: createDemoGateway,
});

export function App({
  gateways = defaultGateways,
}: {
  readonly gateways?: AppGateways;
}) {
  const walletActor = useMemo(
    () => createActor(baseWalletSessionMachine, { input: {} }),
    [],
  );
  const [wallet, setWallet] = useState<
    SnapshotFrom<typeof baseWalletSessionMachine>
  >(walletActor.getSnapshot());
  const unsubscribeWalletRef = useRef<(() => void) | null>(null);

  const perpUiActor = useMemo(
    () => createActor(perpOrderUiMachine, { input: {} }),
    [],
  );
  const [perpUi, setPerpUi] = useState<
    SnapshotFrom<typeof perpOrderUiMachine>
  >(perpUiActor.getSnapshot());
  const [perpDraft, setPerpDraft] = useState<PerpOrderFormDraft>({
    productId: "BTC-PERP",
    side: "BUY",
    quantity: 0.005,
    markPrice: 100_000,
    leverage: 1,
    dailyPnl: 0,
  });
  const inFlightPerpRef = useRef(false);

  const actor = useMemo(
    () =>
      createActor(dashboardSessionMachine, {
        input: { defaultAgentName: "btc-usd--multi" },
      }),
    [],
  );
  const [snapshot, setSnapshot] = useState<
    SnapshotFrom<typeof dashboardSessionMachine>
  >(actor.getSnapshot());
  const [agent, setAgent] = useState<AgentStateView | null>(null);
  const [cycles, setCycles] = useState<readonly CycleView[]>([]);
  const [pnlHistory, setPnlHistory] = useState<PnlHistoryView | null>(null);
  const [portfolioSummary, setPortfolioSummary] =
    useState<PortfolioSummaryView | null>(null);
  const [agentName, setAgentName] = useState("btc-usd--multi");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [productId, setProductId] = useState("BTC-USD");
  const [timeframe, setTimeframe] = useState("ONE_MINUTE");
  const [executionMode, setExecutionMode] = useState<"paper" | "live">("paper");
  const [strategyIds, setStrategyIds] = useState<readonly string[]>([
    "rsi-reversion",
    "ema-cross",
    "breakout",
  ]);
  const [liveConfirmation, setLiveConfirmation] = useState("");
  const [refreshIntervalMs, setRefreshIntervalMs] = useState<number>(15_000);
  const [blotterFilter, setBlotterFilter] = useState<"all" | "fills">("all");
  const [selectedProductId, setSelectedProductId] = useState<string>("ALL");
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const gatewayRef = useRef<DashboardGateway | null>(null);
  const inFlightRef = useRef<string | null>(null);
  const pendingStartRef = useRef<StartConfiguration | undefined>(undefined);

  useEffect(() => {
    actor.start();
    const subscription = actor.subscribe(setSnapshot);
    if (
      typeof globalThis.location?.search === "string" &&
      new URLSearchParams(globalThis.location.search).get("demo") === "1"
    ) {
      gatewayRef.current = gateways.createDemo();
      actor.send({
        type: "CONNECT_REQUESTED",
        agentName: "btc-usd--multi",
        credentialPresent: true,
      });
    } else if (
      typeof globalThis.location?.hostname === "string" &&
      globalThis.location.hostname.endsWith(".workers.dev")
    ) {
      gatewayRef.current = gateways.createHttp("", "");
      actor.send({
        type: "CONNECT_REQUESTED",
        agentName: "btc-usd--multi",
        credentialPresent: false,
        readOnly: true,
      });
    }
    return () => {
      subscription.unsubscribe();
    };
  }, [actor, gateways]);

  useEffect(() => {
    walletActor.start();
    const walletSubscription = walletActor.subscribe(setWallet);
    return () => {
      walletSubscription.unsubscribe();
      unsubscribeWalletRef.current?.();
    };
  }, [walletActor]);

  useEffect(() => {
    perpUiActor.start();
    const perpSubscription = perpUiActor.subscribe(setPerpUi);
    return () => {
      perpSubscription.unsubscribe();
    };
  }, [perpUiActor]);

  useEffect(() => {
    const state = String(snapshot.value);
    if (state === "ready" || state === "disconnected" || state === "error") {
      inFlightRef.current = null;
      return;
    }
    const gateway = gatewayRef.current;
    const target = snapshot.context.agentName;
    if (gateway === null || target === null) return;
    const key = `${state}:${snapshot.context.pendingCommand ?? "none"}`;
    if (inFlightRef.current === key) return;
    inFlightRef.current = key;

    const fail = (error: unknown) => {
      actor.send({ type: "REQUEST_FAILED", error: toDashboardError(error) });
    };
    if (state === "loading" || state === "refreshing") {
      void Promise.all([
        gateway.loadState(target),
        gateway.loadCycles(target),
        gateway.loadPnlHistory(target),
      ])
        .then(([nextAgent, nextCycles, nextPnl]) => {
          actor.send({
            type: "STATE_LOADED",
            remotePhase: nextAgent.phase,
            remoteUpdatedAt: nextAgent.updatedAt,
          });
          if (String(actor.getSnapshot().value) === "ready") {
            setAgent(nextAgent);
            setCycles(nextCycles);
            setPnlHistory(nextPnl);
            setPortfolioSummary(nextAgent.portfolioSummary);
            setNowMs(Date.now());
          }
        })
        .catch(fail);
      return;
    }
    if (state === "commanding" && snapshot.context.pendingCommand !== null) {
      const command = snapshot.context.pendingCommand;
      void gateway
        .command(
          target,
          command,
          command === "start" ? pendingStartRef.current : undefined,
        )
        .then(async (nextAgent) => {
          const [nextCycles, nextPnl] = await Promise.all([
            gateway.loadCycles(target),
            gateway.loadPnlHistory(target),
          ]);
          actor.send({
            type: "COMMAND_SUCCEEDED",
            remotePhase: nextAgent.phase,
            remoteUpdatedAt: nextAgent.updatedAt,
          });
          if (String(actor.getSnapshot().value) === "ready") {
            setAgent(nextAgent);
            setCycles(nextCycles);
            setPnlHistory(nextPnl);
            setPortfolioSummary(nextAgent.portfolioSummary);
            setNowMs(Date.now());
          }
          pendingStartRef.current = undefined;
        })
        .catch(fail);
    }
  }, [actor, snapshot]);

  useEffect(() => {
    if (snapshot.value !== "ready" || refreshIntervalMs <= 0) return;
    const timer = globalThis.setInterval(() => {
      if (actor.getSnapshot().value === "ready") {
        actor.send({ type: "REFRESH_REQUESTED" });
      }
    }, refreshIntervalMs);
    return () => globalThis.clearInterval(timer);
  }, [actor, refreshIntervalMs, snapshot.value]);

  useEffect(() => {
    if (snapshot.value !== "ready") return;
    const clock = globalThis.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => globalThis.clearInterval(clock);
  }, [snapshot.value]);

  const connect = (event: FormEvent) => {
    event.preventDefault();
    gatewayRef.current = gateways.createHttp(apiBaseUrl, token);
    actor.send({
      type: "CONNECT_REQUESTED",
      agentName,
      credentialPresent: token.trim().length > 0,
    });
  };

  const connectDemo = () => {
    gatewayRef.current = gateways.createDemo();
    actor.send({
      type: "CONNECT_REQUESTED",
      agentName: "btc-usd--multi",
      credentialPresent: true,
    });
  };

  const connectReadOnly = () => {
    gatewayRef.current = gateways.createHttp(apiBaseUrl, "");
    actor.send({
      type: "CONNECT_REQUESTED",
      agentName,
      credentialPresent: false,
      readOnly: true,
    });
  };

  const issueCommand = (command: DashboardDirectCommand) => {
    if (command === "start") {
      pendingStartRef.current = createStartConfiguration({
        productId,
        timeframe,
        strategyIds,
        executionMode,
        ...(executionMode === "paper"
          ? {
              intervalSeconds: timeframe === "ONE_MINUTE" ? 60 : 300,
              executionStyle: "LIMIT_PASSIVE" as const,
              strategyOptions: {
                positionAware: true,
                maxTrendStrength: 35,
                minRelativeVolume: 1.1,
              },
              indicators: {
                rsiMode: "WILDER" as const,
                adxWarmupMultiplier: 2,
              },
              risk: {
                atrStopLossMultiple: 2,
                atrTakeProfitMultiple: 3,
              },
              broker: {
                feeBps: 6,
                slippageBps: 2,
                makerFeeBps: 1,
              },
            }
          : {}),
      });
    }
    actor.send({ type: "COMMAND_REQUESTED", command, permissions });
  };

  const toggleStrategy = (strategyId: string) => {
    setStrategyIds((current) =>
      current.includes(strategyId)
        ? current.filter((item) => item !== strategyId)
        : [...current, strategyId],
    );
  };

  const selectExecutionMode = (mode: "paper" | "live") => {
    setExecutionMode(mode);
    setLiveConfirmation("");
    if (mode !== "live") return;
    setTimeframe(LIVE_TRADING_POLICY.timeframe);
    setStrategyIds(LIVE_TRADING_POLICY.strategyIds);
    if (!LIVE_TRADING_PRODUCTS.some((candidate) => candidate === productId)) {
      setProductId("GRT-USD");
    }
  };

  const connectWallet = () => {
    const provider = findInjectedBaseWalletProvider();
    walletActor.send({
      type: "CONNECT_REQUESTED",
      providerPresent: provider !== null,
    });
    if (provider === null) return;
    void connectBaseWallet(provider)
      .then((account) => {
        walletActor.send({
          type: "WALLET_CONNECTED",
          address: account.address,
          chainId: account.chainId,
        });
        unsubscribeWalletRef.current?.();
        unsubscribeWalletRef.current = subscribeBaseWallet(provider, {
          onAccountsChanged: (accounts) => {
            const first = Array.isArray(accounts) ? accounts[0] : undefined;
            if (first === undefined) {
              walletActor.send({ type: "WALLET_ACCOUNT_CHANGED", address: null });
              return;
            }
            if (typeof first !== "string") {
              walletActor.send({
                type: "CONNECTION_FAILED",
                error: { code: "WALLET_INVALID_RESPONSE", retryable: true },
              });
              return;
            }
            walletActor.send({
              type: "WALLET_ACCOUNT_CHANGED",
              address: first.trim().toLowerCase(),
            });
          },
          onChainChanged: (chainId) => {
            const parsed = parseHexChainId(chainId);
            if (parsed === null) {
              walletActor.send({
                type: "CONNECTION_FAILED",
                error: { code: "WALLET_INVALID_RESPONSE", retryable: true },
              });
              return;
            }
            walletActor.send({ type: "WALLET_CHAIN_CHANGED", chainId: parsed });
          },
        });
      })
      .catch((error: unknown) => {
        walletActor.send({
          type: "CONNECTION_FAILED",
          error:
            error instanceof BaseWalletRequestError
              ? error.walletError
              : { code: "WALLET_INVALID_RESPONSE", retryable: true },
        });
      });
  };

  const disconnectWallet = () => {
    unsubscribeWalletRef.current?.();
    unsubscribeWalletRef.current = null;
    walletActor.send({ type: "DISCONNECT_REQUESTED" });
  };

  useEffect(() => {
    if (perpUi.value !== "submitting" || inFlightPerpRef.current) return;
    const gateway = gatewayRef.current;
    const target = snapshot.context.agentName;
    const draft = perpUi.context.draft;
    const clientOrderId = perpUi.context.clientOrderId;
    if (
      gateway === null ||
      target === null ||
      draft === null ||
      clientOrderId === null
    ) {
      perpUiActor.send({
        type: "SUBMISSION_FAILED",
        error: { code: "REQUEST_FAILED", retryable: false },
      });
      return;
    }
    inFlightPerpRef.current = true;
    gateway
      .submitPerpOrder(target, {
        intent: {
          productId: draft.productId,
          side: draft.side,
          quantity: draft.quantity,
          markPrice: draft.markPrice,
          leverage: draft.leverage,
        },
        gate: { dailyPnl: draft.dailyPnl },
        clientOrderId,
      })
      .then((view) => {
        inFlightPerpRef.current = false;
        if (view.status === "FAILED") {
          perpUiActor.send({
            type: "SUBMISSION_FAILED",
            error: { code: "REQUEST_FAILED", retryable: true },
          });
          return;
        }
        if (view.status === "REFUSED" && typeof view.reasonCode === "string") {
          perpUiActor.send({
            type: "SUBMISSION_SUCCEEDED",
            result: {
              status: "REFUSED",
              reasonCode: view.reasonCode as PerpRefusalCode,
            },
          });
          return;
        }
        if (
          view.status === "SETTLED" &&
          (view.outcome === "ACCEPTED" || view.outcome === "REJECTED")
        ) {
          perpUiActor.send({
            type: "SUBMISSION_SUCCEEDED",
            result: {
              status: "SETTLED",
              outcome: view.outcome,
              clientOrderId: view.clientOrderId ?? clientOrderId,
            },
          });
          return;
        }
        perpUiActor.send({
          type: "SUBMISSION_FAILED",
          error: { code: "REQUEST_FAILED", retryable: false },
        });
      })
      .catch(() => {
        inFlightPerpRef.current = false;
        perpUiActor.send({
          type: "SUBMISSION_FAILED",
          error: { code: "REQUEST_FAILED", retryable: true },
        });
      });
  }, [perpUi, perpUiActor, snapshot.context.agentName]);

  const preparePerpOrder = () => {
    perpUiActor.send({
      type: "SUBMISSION_PREPARED",
      draft: perpDraft,
      permissions,
    });
  };

  const confirmPerpOrder = () => {
    perpUiActor.send({
      type: "PERP_ORDER_CONFIRMED",
      permissions,
      clientOrderId: `perp-${Date.now().toString(36)}`,
    });
  };

  const cancelPerpOrder = () => {
    perpUiActor.send({ type: "PERP_ORDER_CANCELLED" });
  };

  const readOnly = snapshot.context.readOnly;
  const busy =
    snapshot.value === "loading" ||
    snapshot.value === "refreshing" ||
    snapshot.value === "commanding";
  const ready =
    snapshot.value === "ready" ||
    snapshot.value === "confirmingKill" ||
    snapshot.value === "commanding" ||
    snapshot.value === "refreshing";
  const activePipeline = PIPELINE.findIndex(
    (item) => item.phase === agent?.phase,
  );
  const liveStartBlocked =
    executionMode === "live" && liveConfirmation !== "LIVE";
  const paperValuation = agent?.paperValuation?.ok
    ? agent.paperValuation.value
    : null;
  const equity =
    paperValuation?.equity ??
    (agent?.portfolioSummary.kind === "portfolio"
      ? agent.portfolioSummary.consolidated.equity
      : null);
  const exposure =
    paperValuation?.exposureNotional ??
    (agent?.portfolioSummary.kind === "portfolio"
      ? agent.portfolioSummary.consolidated.grossExposure
      : null);
  const equityQuality =
    paperValuation?.quality ??
    (agent?.paperValuation?.ok === false ? "unavailable" : null);
  const equityAge = paperValuation?.ageMs ?? null;
  const portfolioProducts =
    portfolioSummary?.kind === "portfolio" ? portfolioSummary.products : [];
  const activeProduct =
    portfolioProducts.length > 0
      ? (portfolioProducts.find((p) => p.productId === selectedProductId) ??
        portfolioProducts[0] ??
        null)
      : null;
  const isConsolidatedView =
    portfolioSummary?.kind === "portfolio" && selectedProductId === "ALL";
  const displayProductId =
    activeProduct?.productId ??
    agent?.configuration?.productId ??
    "Non configuré";

  const rawEquityPoints =
    pnlHistory?.equityCurve.filter(
      (point): point is typeof point & { readonly equity: number } =>
        point.equity !== null,
    ) ?? [];
  const plottedEquityCurve = useMemo(() => {
    if (selectedProductId !== "ALL") {
      return rawEquityPoints.filter(
        (point) => !point.productId || point.productId === selectedProductId,
      );
    }
    if (
      portfolioProducts.length > 1 &&
      rawEquityPoints.some((point) => typeof point.productId === "string")
    ) {
      const latestByProduct = new Map<string, number>();
      for (const product of portfolioProducts) {
        const firstPoint = rawEquityPoints.find(
          (pt) => pt.productId === product.productId,
        );
        latestByProduct.set(
          product.productId,
          firstPoint?.equity ?? product.valuation.equity ?? product.cash,
        );
      }
      return rawEquityPoints.map((point) => {
        if (typeof point.productId === "string") {
          latestByProduct.set(point.productId, point.equity);
        }
        let sum = 0;
        for (const val of latestByProduct.values()) {
          sum += val;
        }
        return { ...point, equity: sum };
      });
    }
    return rawEquityPoints;
  }, [portfolioProducts, rawEquityPoints, selectedProductId]);
  const chartGeometry = equityGeometry(plottedEquityCurve);

  const allPnlCycles = pnlHistory?.cycles ?? [];
  const allFilledCycles = allPnlCycles.filter((cycle) => cycle.side !== null);
  const scopedPnlCycles =
    selectedProductId === "ALL"
      ? allPnlCycles
      : allPnlCycles.filter(
          (cycle) => !cycle.productId || cycle.productId === selectedProductId,
        );
  const filledCycles = scopedPnlCycles.filter((cycle) => cycle.side !== null);
  const visibleBlotterCycles =
    blotterFilter === "fills" ? filledCycles : scopedPnlCycles;
  const totalRealizedPnl = filledCycles.reduce(
    (acc, item) => acc + (item.realizedPnl ?? 0),
    0,
  );
  const totalFees = filledCycles.reduce(
    (acc, item) => acc + (item.fee ?? 0),
    0,
  );
  const avgSlippageBps =
    filledCycles.length === 0
      ? 0
      : filledCycles.reduce((acc, item) => acc + (item.slippageBps ?? 0), 0) /
        filledCycles.length;

  const stopPrice = pnlHistory?.protection?.stopLossPrice ?? null;
  const takePrice = pnlHistory?.protection?.takeProfitPrice ?? null;
  const entryPrice = pnlHistory?.openPosition?.averagePrice ?? null;
  const currentMark =
    paperValuation?.markPrice ?? agent?.lastCycle?.marketPrice ?? entryPrice;
  const clampPercent = (price: number | null): number | null => {
    if (
      price === null ||
      stopPrice === null ||
      takePrice === null ||
      takePrice <= stopPrice
    ) {
      return null;
    }
    return Math.min(
      100,
      Math.max(0, ((price - stopPrice) / (takePrice - stopPrice)) * 100),
    );
  };
  const entryPercent = clampPercent(entryPrice);
  const markPercent = clampPercent(currentMark ?? null);
  const displayEquity = isConsolidatedView
    ? portfolioSummary.consolidated.equity
    : activeProduct !== null
      ? activeProduct.valuation.equity
      : equity;
  const displayExposure = isConsolidatedView
    ? portfolioSummary.consolidated.grossExposure
    : activeProduct !== null
      ? activeProduct.grossExposure
      : exposure;
  const displayDailyPnl = isConsolidatedView
    ? portfolioSummary.consolidated.dailyPnl
    : activeProduct !== null
      ? activeProduct.dailyPnl
      : (agent?.dailyPnl ?? 0);
  const displayPositionQty = activeProduct !== null
    ? activeProduct.positionQuantity
    : (agent?.portfolio.positionQuantity ?? 0);
  const displayAvgPrice = activeProduct !== null
    ? activeProduct.averagePrice
    : (agent?.portfolio.averagePrice ?? 0);
  const displayCash = activeProduct !== null
    ? activeProduct.cash
    : (agent?.portfolio.cash ?? 0);
  const displayPrice =
    activeProduct?.marketPrice ??
    paperValuation?.markPrice ??
    agent?.lastCycle?.marketPrice ??
    null;
  const displayOutcome =
    activeProduct?.lastCycle?.outcome ?? agent?.lastCycle?.outcome ?? null;
  const decisionSummary = describeLatestDecision({
    enabled: agent?.enabled ?? false,
    productId: displayProductId,
    outcome: displayOutcome,
    price: displayPrice,
    indicators: agent?.indicators ?? null,
    nextWakeAt: agent?.nextWakeAt ?? null,
    nowMs,
  });

  return (
    <main className="dashboard-shell">
      <header className="telemetry-bar">
        <div className="brand-cluster">
          <div className="brand-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M3 13h4l3-7 4 14 3-7h4"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="brand-title-group">
            <h1>DoDash Trading Agent</h1>
            <p className="brand-subtitle">
              Cockpit d’observation et de pilotage temps réel sur Cloudflare Durable Objects.
            </p>
          </div>
        </div>

        <div className="telemetry-center">
          {ready && agent !== null && (
            <>
              <div className="telemetry-pill">
                <span
                  className={`pulse-dot ${
                    agent.enabled ? "live" : "danger"
                  }`}
                />
                <span>RÉVEIL</span>
                <strong>{formatCountdown(agent.nextWakeAt, nowMs)}</strong>
              </div>
              {/* biome-ignore lint/a11y/useSemanticElements: groupe de boutons de présentation */}
              <div
                className="cadence-group"
                role="group"
                aria-label="Cadence de rafraîchissement"
              >
                {[
                  { label: "5s", ms: 5_000 },
                  { label: "15s", ms: 15_000 },
                  { label: "30s", ms: 30_000 },
                  { label: "Pause", ms: 0 },
                ].map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    className={`cadence-btn ${
                      refreshIntervalMs === opt.ms ? "active" : ""
                    }`}
                    onClick={() => setRefreshIntervalMs(opt.ms)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="cadence-btn"
                disabled={busy}
                onClick={() => actor.send({ type: "REFRESH_REQUESTED" })}
              >
                Rafraîchir
              </button>
            </>
          )}
        </div>

        <div className="connection-stamp" aria-live="polite">
          <span>SESSION</span>
          <strong>
            {ready
              ? readOnly
                ? "LECTURE SEULE"
                : "CONNECTÉE"
              : busy
                ? "CHARGEMENT"
                : "VERROUILLÉE"}
          </strong>
          <small>{snapshot.context.agentName ?? "aucune cible"}</small>
        </div>
      </header>

      {(!ready || !readOnly) && (
        <div className="sub-telemetry-bar">
          <BaseWalletCard
            snapshot={wallet}
            onConnect={connectWallet}
            onDisconnect={disconnectWallet}
          />
        </div>
      )}

      {!ready ? (
        <section className="access-section">
          <div className="access-grid">
            <form className="paper-card access-card" onSubmit={connect}>
              <h2>Choisir l’agent</h2>
              <p>
                Le token reste en mémoire vive. Il n’est ni stocké, ni placé
                dans l’URL.
              </p>
              <label>
                Cible
                <input
                  value={agentName}
                  onChange={(event) => setAgentName(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                Base API
                <input
                  value={apiBaseUrl}
                  onChange={(event) => setApiBaseUrl(event.target.value)}
                  placeholder="même origine"
                  inputMode="url"
                />
              </label>
              <label>
                Token dashboard
                <input
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  type="password"
                  autoComplete="off"
                />
              </label>
              {snapshot.context.lastError !== null && (
                <p className="error-note" role="alert">
                  {snapshot.context.lastError.code}
                </p>
              )}
              <div className="button-row">
                <button className="button primary" type="submit" disabled={busy}>
                  Connecter
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={connectReadOnly}
                  disabled={busy}
                >
                  Observer sans token (lecture seule)
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={connectDemo}
                  disabled={busy}
                >
                  Voir la démo
                </button>
              </div>
            </form>
            <aside className="paper-card access-note">
              <h2>Le modèle décide</h2>
              <p>
                Le dashboard ne modifie jamais l’état affiché avant la réponse
                du Durable Object. Une commande est un événement typé, pas une
                instruction libre.
              </p>
              <ol>
                <li>Authentifier le proxy</li>
                <li>Valider l’état distant</li>
                <li>Émettre une commande autorisée</li>
              </ol>
            </aside>
          </div>
        </section>
      ) : agent === null ? (
        <section className="loading-panel" aria-live="polite">
          Lecture de l’état durable…
        </section>
      ) : (
        <div className="narrative-shell">
          {/* 1. HERO NARRATIVE DECISION BANNER */}
          <section className={`paper-card decision-banner tone-${decisionSummary.tone}`}>
            <div className="decision-banner-top">
              <div className="decision-banner-title">
                <span className={`outcome ${decisionSummary.tone}`}>
                  {decisionSummary.badge}
                </span>
                <h2>{decisionSummary.headline}</h2>
              </div>
              {portfolioProducts.length > 0 && (
                /* biome-ignore lint/a11y/useSemanticElements: groupe de boutons de présentation */
                <div className="cadence-group pair-switcher" role="group" aria-label="Sélection de paire">
                  <button
                    type="button"
                    className={`cadence-btn ${selectedProductId === "ALL" ? "active" : ""}`}
                    onClick={() => setSelectedProductId("ALL")}
                  >
                    Toutes
                  </button>
                  {portfolioProducts.map((p) => (
                    <button
                      key={p.productId}
                      type="button"
                      className={`cadence-btn ${selectedProductId === p.productId ? "active" : ""}`}
                      aria-label={`Afficher ${p.productId}`}
                      onClick={() => setSelectedProductId(p.productId)}
                    >
                      {p.productId.split("-")[0]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="decision-explanation">{decisionSummary.explanation}</p>
            <div className="decision-meta-row">
              <span>
                Mode : <strong>{agent.configuration?.executionMode.toUpperCase() ?? "PAPER"}</strong> ·{" "}
                {agent.configuration?.timeframe.replaceAll("_", " ") ?? "ONE MINUTE"}
              </span>
              {agent.configuration?.executionMode === "paper" && (
                <span>
                  Prix mark{" "}
                  {equityQuality === "fresh"
                    ? "à jour"
                    : equityQuality === "stale"
                      ? "périmé"
                      : "indisponible"}
                  {equityAge === null ? "" : ` (${Math.round(equityAge / 1_000)} s)`}
                </span>
              )}
            </div>
          </section>

          {/* 2. 3-CARD DIGESTIBLE SUMMARY ROW */}
          <div className="summary-trio">
            {/* Card 1: Capital & PnL */}
            <article className="paper-card">
              <div className="module-header">
                <h2>{isConsolidatedView ? "Capital consolidé" : `Capital · ${displayProductId}`}</h2>
                <span className={`phase-badge ${agent.enabled ? "online" : "offline"}`}>
                  {phaseLabel(agent.phase)}
                </span>
              </div>
              <div className="metric-grid">
                <Metric
                  label="ÉQUITÉ"
                  value={displayEquity === null ? "—" : money.format(displayEquity)}
                  accent="blue-text"
                />
                <Metric
                  label="PNL JOUR"
                  value={money.format(displayDailyPnl)}
                  accent={displayDailyPnl >= 0 ? "green-text" : "red-text"}
                />
                <Metric
                  label="EXPOSITION"
                  value={displayExposure === null ? "INDISPONIBLE" : money.format(displayExposure)}
                  accent="blue-text"
                />
                <Metric
                  label="TRÉSORERIE"
                  value={money.format(displayCash)}
                />
              </div>
            </article>

            {/* Card 2: Position & Protections */}
            <article className="paper-card">
              <div className="module-header">
                <h2>Position ouverte · {displayProductId}</h2>
                <span className="sync-time">
                  {displayPrice === null ? "—" : money.format(displayPrice)}
                </span>
              </div>
              <div className="metric-grid" style={{ marginBottom: "12px" }}>
                <Metric
                  label="POSITION"
                  value={quantity.format(displayPositionQty)}
                />
                <Metric
                  label="PRIX MOYEN"
                  value={money.format(displayAvgPrice)}
                />
              </div>
              {pnlHistory !== null && (
                <div className="protection-panel" style={{ marginTop: 0 }}>
                  {/* biome-ignore lint/a11y/useSemanticElements: groupe de badges de présentation */}
                  <div
                    className="protection-badges"
                    role="group"
                    aria-label="Position et protections"
                  >
                    {pnlHistory.openPosition === null ? (
                      <span className="outcome neutral">AUCUNE POSITION</span>
                    ) : (
                      <>
                        <span className="outcome neutral">
                          POSITION {quantity.format(pnlHistory.openPosition.quantity)}
                        </span>
                        {pnlHistory.protection === null ? (
                          <span className="outcome negative">NON PROTÉGÉ</span>
                        ) : (
                          <>
                            <span className="outcome negative">
                              STOP {money.format(pnlHistory.protection.stopLossPrice)}
                            </span>
                            <span className="outcome positive">
                              TAKE-PROFIT {money.format(pnlHistory.protection.takeProfitPrice)}
                            </span>
                            <span
                              className={`outcome ${
                                pnlHistory.protection.protectiveOrderConfirmed
                                  ? "positive"
                                  : "neutral"
                              }`}
                            >
                              {pnlHistory.protection.protectiveOrderConfirmed
                                ? "PROTECTION CONFIRMÉE"
                                : "PROTECTION NON CONFIRMÉE"}
                            </span>
                          </>
                        )}
                      </>
                    )}
                  </div>
                  {pnlHistory.openPosition !== null &&
                    pnlHistory.protection !== null &&
                    entryPercent !== null && (
                      <div className="protection-scale">
                        <div className="protection-track">
                          <div
                            className="protection-marker entry"
                            style={{ left: `${entryPercent}%` }}
                            title="Prix moyen d'entrée"
                          />
                          {markPercent !== null && (
                            <div
                              className="protection-marker mark"
                              style={{ left: `${markPercent}%` }}
                              title="Prix de marque actuel"
                            />
                          )}
                        </div>
                        <div className="protection-scale-labels">
                          <div>
                            <small>SL</small>
                            <strong>{money.format(pnlHistory.protection.stopLossPrice)}</strong>
                          </div>
                          <div>
                            <small>Entrée</small>
                            <strong>{money.format(pnlHistory.openPosition.averagePrice)}</strong>
                          </div>
                          <div>
                            <small>TP</small>
                            <strong>{money.format(pnlHistory.protection.takeProfitPrice)}</strong>
                          </div>
                        </div>
                      </div>
                    )}
                </div>
              )}
            </article>

            {/* Card 3: Market Health (Translated Indicators) */}
            <article className="paper-card indicator-card">
              <div className="module-header">
                <h2>Santé du marché</h2>
                <span className="sync-time">INDICATEURS</span>
              </div>
              {agent.indicators === null ? (
                <p className="empty-state">Aucun snapshot calculé.</p>
              ) : (
                <>
                  <div className="rsi-meter">
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.75rem",
                      }}
                    >
                      <span style={{ color: "var(--fg-muted)" }}>
                        RSI · {describeRsiZone(agent.indicators.rsi).label}
                      </span>
                      <strong>{agent.indicators.rsi.toFixed(1)}</strong>
                    </div>
                    <div className="rsi-meter-bar">
                      <div
                        className="rsi-meter-Thumb"
                        style={{
                          left: `${Math.min(100, Math.max(0, agent.indicators.rsi))}%`,
                        }}
                      />
                    </div>
                  </div>
                  <dl>
                    <div>
                      <dt>Tendance EMA</dt>
                      <dd className={agent.indicators.emaFast >= agent.indicators.emaSlow ? "pnl-positive" : "pnl-negative"}>
                        {agent.indicators.emaFast >= agent.indicators.emaSlow ? "Haussière" : "Baissière"}
                      </dd>
                    </div>
                    <div>
                      <dt>MACD</dt>
                      <dd>{agent.indicators.macd.toFixed(2)}</dd>
                    </div>
                    <div>
                      <dt>Volatilité (ATR)</dt>
                      <dd>{agent.indicators.atr.toFixed(2)}</dd>
                    </div>
                  </dl>
                </>
              )}
            </article>
          </div>

          {/* 3. EQUITY CURVE & LIVE ACTIVITY FEED (OPTIMIZED 13.3" SPLIT) */}
          <section className="paper-card performance-card">
            <div className="module-header performance-header">
              <div className="performance-title-cluster">
                <h2>PERFORMANCE</h2>
                <span className="scope-pill">
                  {isConsolidatedView
                    ? `Portefeuille consolidé (${portfolioProducts.length} paires)`
                    : `Portefeuille : ${displayProductId.replace("-", "/")}`}
                </span>
              </div>
              <div className="performance-header-right">
                {portfolioProducts.length > 0 && (
                  /* biome-ignore lint/a11y/useSemanticElements: groupe de boutons de présentation */
                  <div
                    className="cadence-group"
                    role="group"
                    aria-label="Filtrer la performance par portefeuille"
                  >
                    <button
                      type="button"
                      className={`cadence-btn ${selectedProductId === "ALL" ? "active" : ""}`}
                      onClick={() => setSelectedProductId("ALL")}
                    >
                      Toutes ({allFilledCycles.length})
                    </button>
                    {portfolioProducts.map((p) => {
                      const pairFillCount = allFilledCycles.filter(
                        (c) => c.productId === p.productId,
                      ).length;
                      const shortSymbol = p.productId.split("-")[0] ?? p.productId;
                      return (
                        <button
                          key={p.productId}
                          type="button"
                          className={`cadence-btn ${selectedProductId === p.productId ? "active" : ""}`}
                          onClick={() => setSelectedProductId(p.productId)}
                        >
                          {shortSymbol} ({pairFillCount})
                        </button>
                      );
                    })}
                  </div>
                )}
                <span className="sync-time">
                  {pnlHistory ? `${plottedEquityCurve.length} POINTS` : "—"}
                </span>
              </div>
            </div>

            {pnlHistory !== null && (
              <>
                <div className="kpi-strip">
                  <div className="kpi-cell">
                    <span>Trades exécutés</span>
                    <strong>{filledCycles.length}</strong>
                  </div>
                  <div className="kpi-cell">
                    <span>PnL réalisé</span>
                    <strong className={signedClass(totalRealizedPnl)}>
                      {money.format(totalRealizedPnl)}
                    </strong>
                  </div>
                  <div className="kpi-cell">
                    <span>Frais cumulés</span>
                    <strong>{money.format(totalFees)}</strong>
                  </div>
                  <div className="kpi-cell">
                    <span>Slippage moyen</span>
                    <strong>{bps.format(avgSlippageBps)} bps moy.</strong>
                  </div>
                </div>

                <div className="performance-split">
                  <div className="equity-chart-container">
                    {plottedEquityCurve.length < 2 ? (
                      <p className="empty-state">Aucun point d’équité.</p>
                    ) : (
                      <>
                        <div className="equity-chart-bounds">
                          <span>
                            Min {money.format(Math.min(...plottedEquityCurve.map((p) => p.equity)))}
                          </span>
                          <span>
                            Dernier {money.format(plottedEquityCurve.at(-1)?.equity ?? 0)}
                          </span>
                          <span>
                            Max {money.format(Math.max(...plottedEquityCurve.map((p) => p.equity)))}
                          </span>
                        </div>
                        <svg
                          className="equity-chart"
                          viewBox="0 0 600 160"
                          preserveAspectRatio="none"
                          role="img"
                          aria-label="Courbe d’équité"
                        >
                          <line x1="0" y1="32" x2="600" y2="32" className="grid-line" />
                          <line x1="0" y1="80" x2="600" y2="80" className="grid-line" />
                          <line x1="0" y1="128" x2="600" y2="128" className="grid-line" />
                          <path className="area" d={chartGeometry.area} />
                          <path className="line" d={chartGeometry.line} />
                          {chartGeometry.lastPoint !== null && (
                            <circle
                              className="terminal-node"
                              cx={chartGeometry.lastPoint.x}
                              cy={chartGeometry.lastPoint.y}
                              r="4"
                            />
                          )}
                        </svg>
                      </>
                    )}
                  </div>

                  <div className="blotter-pane">
                    <div className="blotter-toolbar">
                      <h3>Fil d’activité en direct</h3>
                      {/* biome-ignore lint/a11y/useSemanticElements: groupe de boutons de présentation */}
                      <div className="cadence-group" role="group" aria-label="Filtre des trades">
                        <button
                          type="button"
                          className={`cadence-btn ${blotterFilter === "all" ? "active" : ""}`}
                          onClick={() => setBlotterFilter("all")}
                        >
                          Tous ({scopedPnlCycles.length})
                        </button>
                        <button
                          type="button"
                          className={`cadence-btn ${blotterFilter === "fills" ? "active" : ""}`}
                          onClick={() => setBlotterFilter("fills")}
                        >
                          Trades exécutés ({filledCycles.length})
                        </button>
                      </div>
                    </div>

                    <div className="table-card blotter-table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Portefeuille</th>
                            <th>Heure</th>
                            <th>Sens</th>
                            <th>Quantité</th>
                            <th>Prix</th>
                            <th>PnL réalisé</th>
                            <th>Frais</th>
                            <th>Slippage</th>
                            <th>Décision</th>
                            <th>Cycle</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleBlotterCycles.map((cycle) => {
                            const resolvedPair =
                              cycle.productId ??
                              (portfolioProducts.length === 0
                                ? (agent.configuration?.productId ?? null)
                                : null);
                            const pairBase =
                              resolvedPair === null
                                ? "—"
                                : (resolvedPair.split("-")[0] ?? resolvedPair);
                            const pairLabel =
                              resolvedPair === null
                                ? "—"
                                : resolvedPair.replace("-", "/");
                            return (
                              <tr
                                key={cycle.cycleId}
                                className={
                                  cycle.side === "BUY"
                                    ? "fill-row-buy"
                                    : cycle.side === "SELL"
                                      ? "fill-row-sell"
                                      : ""
                                }
                              >
                                <td>
                                  {resolvedPair === null ? (
                                    "—"
                                  ) : (
                                    <button
                                      type="button"
                                      className={`pair-pill pair-${pairBase.toLowerCase()}`}
                                      title={`Filtrer sur ${resolvedPair}`}
                                      onClick={() =>
                                        setSelectedProductId((current) =>
                                          current === resolvedPair ? "ALL" : resolvedPair,
                                        )
                                      }
                                    >
                                      {pairLabel}
                                    </button>
                                  )}
                                </td>
                                <td>{compactDate.format(cycle.triggeredAt)}</td>
                                <td>
                                  {cycle.side === null ? (
                                    "—"
                                  ) : (
                                    <span className={`side-pill ${cycle.side.toLowerCase()}`}>
                                      {cycle.side === "BUY" ? "ACHAT" : "VENTE"}
                                    </span>
                                  )}
                                </td>
                                <td>{cycle.quantity === null ? "—" : quantity.format(cycle.quantity)}</td>
                                <td>{cycle.fillPrice === null ? (cycle.marketPrice === null ? "—" : money.format(cycle.marketPrice)) : money.format(cycle.fillPrice)}</td>
                                <td>
                                  {cycle.realizedPnl === null ? (
                                    "—"
                                  ) : (
                                    <span className={signedClass(cycle.realizedPnl)}>
                                      {money.format(cycle.realizedPnl)}
                                    </span>
                                  )}
                                </td>
                                <td>{cycle.fee === null ? "—" : money.format(cycle.fee)}</td>
                                <td>
                                  {cycle.slippageBps === null ? (
                                    "—"
                                  ) : (
                                    <span className={signedClass(-cycle.slippageBps)}>
                                      {cycle.slippageBps >= 0 ? "+" : ""}
                                      {bps.format(cycle.slippageBps)} bps
                                    </span>
                                  )}
                                </td>
                                <td>
                                  <span className={`outcome ${outcomeClass(cycle.outcome)}`}>
                                    {outcomeLabel(cycle.outcome)}
                                  </span>
                                </td>
                                <td><code>{cycle.cycleId}</code></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {visibleBlotterCycles.length === 0 && (
                        <p className="empty-state">Aucun cycle dans la fenêtre.</p>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </section>

          {/* 4. PORTFOLIO OVERVIEW (WHEN MULTI-PRODUCT) */}
          {portfolioSummary?.kind === "portfolio" && (
            <section className="paper-card">
              <div className="module-header">
                <h2>PORTEFEUILLE</h2>
                <span className="sync-time">VUE PAR PAIRE</span>
              </div>
              <div className="portfolio-grid">
                {portfolioSummary.products.map((product) => (
                  <article className="product-card" key={product.productId}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <strong>{product.productId}</strong>
                      <span
                        className={`phase-badge ${
                          product.status === "running" ? "online" : "offline"
                        }`}
                      >
                        {portfolioStatusLabel(product.status)}
                      </span>
                    </div>
                    <h2>{phaseLabel(product.phase as DashboardRemotePhase)}</h2>
                    <div className="metric-grid">
                      <Metric
                        label="EXPOSITION"
                        value={
                          product.grossExposure === null
                            ? "INDISPONIBLE"
                            : money.format(product.grossExposure)
                        }
                        accent="blue-text"
                      />
                      <Metric
                        label="PLAFOND PRODUIT"
                        value={money.format(product.maxGrossExposure)}
                      />
                      <Metric
                        label="PNL JOUR"
                        value={money.format(product.dailyPnl)}
                        accent={product.dailyPnl >= 0 ? "green-text" : "red-text"}
                      />
                      <Metric
                        label="POSITION"
                        value={quantity.format(product.positionQuantity)}
                      />
                    </div>
                    <p className="next-wake">
                      Dernier cycle :{" "}
                      {product.lastCycle === null
                        ? "aucun"
                        : `${outcomeLabel(product.lastCycle.outcome)} · ${compactDate.format(product.lastCycle.completedAt)}`}
                    </p>
                  </article>
                ))}
                <article className="consolidated-card">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <strong>CONSOLIDÉ</strong>
                    <span
                      className={`phase-badge ${
                        portfolioSummary.killSwitchActive ? "offline" : "online"
                      }`}
                    >
                      {portfolioSummary.killSwitchActive
                        ? "KILL SWITCH ENGAGÉ"
                        : phaseLabel(portfolioSummary.phase as DashboardRemotePhase)}
                    </span>
                  </div>
                  <h2>Garde-fous du portefeuille</h2>
                  <div className="metric-grid">
                    <Metric
                      label="EXPOSITION CONSOLIDÉE"
                      value={
                        portfolioSummary.consolidated.grossExposure === null
                          ? "INDISPONIBLE"
                          : money.format(portfolioSummary.consolidated.grossExposure)
                      }
                      accent="blue-text"
                    />
                    <Metric
                      label="ÉQUITÉ CONSOLIDÉE"
                      value={
                        portfolioSummary.consolidated.equity === null
                          ? "INDISPONIBLE"
                          : money.format(portfolioSummary.consolidated.equity)
                      }
                    />
                    <Metric
                      label="PLAFOND PORTEFEUILLE"
                      value={money.format(portfolioSummary.consolidated.maxGrossExposure)}
                    />
                    <Metric
                      label="PNL JOUR CONSOLIDÉ"
                      value={money.format(portfolioSummary.consolidated.dailyPnl)}
                      accent={
                        portfolioSummary.consolidated.dailyPnl >= 0
                          ? "green-text"
                          : "red-text"
                      }
                    />
                    <Metric
                      label="PLAFOND PERTE JOUR"
                      value={money.format(portfolioSummary.consolidated.maxDailyLoss)}
                    />
                  </div>
                </article>
              </div>
            </section>
          )}

          {/* 5. LOOP CONTROL STRIP */}
          <article className="paper-card control-card">
            <div className="module-header">
              <h2>Piloter la boucle</h2>
              <span className="sync-time">MAJ {compactDate.format(agent.updatedAt)}</span>
            </div>
            <div className="control-strip">
              <div className="control-buttons-inline">
                <button
                  className="button primary"
                  type="button"
                  onClick={() => issueCommand("tick")}
                  disabled={readOnly || busy || !agent.enabled}
                >
                  Exécuter maintenant
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => issueCommand("stop")}
                  disabled={readOnly || busy || !agent.enabled}
                >
                  Arrêter
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => issueCommand("reset")}
                  disabled={
                    readOnly ||
                    busy ||
                    (agent.phase !== "failed" && agent.phase !== "halted")
                  }
                >
                  Réinitialiser
                </button>
                <button
                  className="button danger"
                  type="button"
                  onClick={() =>
                    actor.send({
                      type: "KILL_CONFIRMATION_REQUESTED",
                      permissions,
                    })
                  }
                  disabled={readOnly || busy || !agent.enabled}
                >
                  Kill switch
                </button>
              </div>
              <div className="control-meta">
                {readOnly && (
                  <span className="agent-meta">
                    Mode lecture seule actif — aucune action de trading autorisée.
                  </span>
                )}
                <button
                  className="text-button"
                  type="button"
                  onClick={() => actor.send({ type: "DISCONNECT_REQUESTED" })}
                >
                  {readOnly ? "Déverrouiller avec un token" : "Fermer la session"}
                </button>
              </div>
            </div>
          </article>

          {/* 6. COLLAPSIBLE EXPERT DRAWER (Pipeline XState, Stratégies, Start Form, SQLite & Perp Ticket) */}
          <details className="paper-card expert-drawer" open={!readOnly}>
            <summary className="expert-drawer-summary">
              <span>Détails techniques, boucle XState & réglages avancés</span>
              <span className="sync-time">
                {readOnly ? "REPLIÉ (LECTURE SEULE)" : "EXPERT"}
              </span>
            </summary>
            <div className="expert-drawer-body">
              <div className="lower-two-col">
                <section className="paper-card">
                  <div className="module-header">
                    <h2>Boucle d’exécution XState</h2>
                    <span className="sync-time">7 PHASES</span>
                  </div>
                  {/* biome-ignore lint/a11y/useSemanticElements: conteneur de présentation, fieldset altérerait le rendu */}
                  <div
                    className="pipeline"
                    role="group"
                    aria-label={`Phase courante : ${phaseLabel(agent.phase)}`}
                  >
                    {PIPELINE.map((item, index) => (
                      <div
                        key={item.phase}
                        className={`pipeline-step step-${item.color} ${
                          index === activePipeline ? "active" : ""
                        }`}
                      >
                        <i className={`step-cell-mark ${item.color}`} />
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <strong>{item.label}</strong>
                        <small>{index === activePipeline ? "EN COURS" : "CONTRÔLÉ"}</small>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="paper-card">
                  <div className="module-header">
                    <h2>Stratégies actives</h2>
                    <span className="sync-time">
                      {(agent.configuration?.strategyIds ?? []).length} ACTIVES
                    </span>
                  </div>
                  <div className="strategy-list">
                    {(agent.configuration?.strategyIds ?? []).map((strategy) => (
                      <article className="strategy-card" key={strategy}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <h3>{strategy}</h3>
                          <span className="phase-badge online">ACTIVE</span>
                        </div>
                        <p>
                          Évalue les bougies closes et transmet un signal typé à l’allocateur.
                        </p>
                      </article>
                    ))}
                  </div>
                </section>
              </div>

              {!agent.enabled && agent.phase === "stopped" && (
                <section className="paper-card start-card">
                  <div className="module-header">
                    <h2>Configuration de démarrage</h2>
                    <span className="sync-time">PARAMÈTRES D’EXÉCUTION</span>
                  </div>
                  <div className="start-fields">
                    {/* biome-ignore lint/a11y/noLabelWithoutControl: le ternaire contient toujours un select ou un input */}
                    <label>
                      Produit
                      {executionMode === "live" ? (
                        <select
                          value={productId}
                          onChange={(event) => setProductId(event.target.value)}
                        >
                          {LIVE_TRADING_PRODUCTS.map((product) => (
                            <option key={product} value={product}>
                              {product}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={productId}
                          onChange={(event) => setProductId(event.target.value.toUpperCase())}
                        />
                      )}
                    </label>
                    <label>
                      Timeframe
                      <select
                        value={timeframe}
                        disabled={executionMode === "live"}
                        onChange={(event) => setTimeframe(event.target.value)}
                      >
                        <option value="ONE_MINUTE">1 minute</option>
                        <option value="FIVE_MINUTE">5 minutes</option>
                        <option value="ONE_HOUR">1 heure</option>
                        <option value="ONE_DAY">1 jour</option>
                      </select>
                    </label>
                    <label>
                      Exécution
                      <select
                        value={executionMode}
                        onChange={(event) =>
                          selectExecutionMode(event.target.value as "paper" | "live")
                        }
                      >
                        <option value="paper">Paper</option>
                        <option value="live">Live</option>
                      </select>
                    </label>
                  </div>
                  <fieldset>
                    <legend>Stratégies</legend>
                    {["rsi-reversion", "ema-cross", "breakout"].map((strategy) => (
                      <label className="check-label" key={strategy}>
                        <input
                          type="checkbox"
                          checked={strategyIds.includes(strategy)}
                          disabled={executionMode === "live"}
                          onChange={() => toggleStrategy(strategy)}
                        />
                        {strategy}
                      </label>
                    ))}
                  </fieldset>
                  {executionMode === "live" && (
                    <label className="live-confirmation">
                      Confirmer en saisissant LIVE
                      <input
                        value={liveConfirmation}
                        onChange={(event) => setLiveConfirmation(event.target.value)}
                        autoComplete="off"
                      />
                    </label>
                  )}
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => issueCommand("start")}
                    disabled={
                      readOnly || busy || strategyIds.length === 0 || liveStartBlocked
                    }
                  >
                    Démarrer l’agent
                  </button>
                </section>
              )}

              <div className="lower-two-col">
                <section className="paper-card">
                  <div className="module-header">
                    <h2>Journal des cycles SQLite</h2>
                    <span className="sync-time">{cycles.length} CYCLES</span>
                  </div>
                  <div className="table-card">
                    <table>
                      <thead>
                        <tr>
                          <th>Cycle</th>
                          <th>Déclenché</th>
                          <th>Issue</th>
                          <th>Phase finale</th>
                          <th>Durée</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cycles.map((cycle) => (
                          <tr key={cycle.cycleId}>
                            <td><code>{cycle.cycleId}</code></td>
                            <td>{compactDate.format(cycle.triggeredAt)}</td>
                            <td>
                              <span className={`outcome ${outcomeClass(cycle.outcome)}`}>
                                {cycle.outcome}
                              </span>
                            </td>
                            <td>{cycle.phase}</td>
                            <td>
                              {cycle.completedAt === null
                                ? "—"
                                : `${((cycle.completedAt - cycle.triggeredAt) / 1_000).toFixed(1)} s`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {cycles.length === 0 && (
                      <p className="empty-state">Aucun cycle persisté.</p>
                    )}
                  </div>
                </section>

                <section className="paper-card perp-card">
                  <div className="module-header">
                    <h2>Ordre manuel sur l'enveloppe figée</h2>
                    <span className="phase-badge offline">
                      {perpUi.value === "submitting" ? "SOUMISSION" : "MANUEL"}
                    </span>
                  </div>
                  <p className="module-subtitle">
                    Marchés BTC-PERP et ETH-PERP, levier ≤ {HYPERLIQUID_PERP_POLICY.maxLeverage}x.
                  </p>
                  {perpUi.context.lastRefusal !== null && (
                    <p className="error-note" role="alert">
                      {perpUi.context.lastRefusal}
                    </p>
                  )}
                  {perpUi.value === "result" && (
                    <p className="next-wake" aria-live="polite">
                      {perpUi.context.result?.status === "SETTLED"
                        ? `ORDRE ${perpUi.context.result.outcome} · ${perpUi.context.result.clientOrderId}`
                        : perpUi.context.result?.status === "REFUSED"
                          ? `REFUSÉ · ${perpUi.context.result.reasonCode}`
                          : perpUi.context.result?.status === "FAILED"
                            ? `ÉCHEC · ${perpUi.context.result.errorCode}`
                            : (perpUi.context.lastError?.code ?? "—")}
                    </p>
                  )}
                  {perpUi.value === "form" && (
                    <div className="start-fields">
                      <label>
                        Marché
                        <select
                          value={perpDraft.productId}
                          onChange={(event) =>
                            setPerpDraft((current) => ({
                              ...current,
                              productId: event.target.value as PerpOrderFormDraft["productId"],
                            }))
                          }
                        >
                          {HYPERLIQUID_PERP_POLICY.products.map((product) => (
                            <option key={product} value={product}>
                              {product}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Sens
                        <select
                          value={perpDraft.side}
                          onChange={(event) =>
                            setPerpDraft((current) => ({
                              ...current,
                              side: event.target.value as PerpOrderFormDraft["side"],
                            }))
                          }
                        >
                          <option value="BUY">Achat (long)</option>
                          <option value="SELL">Vente (short)</option>
                        </select>
                      </label>
                      <label>
                        Quantité
                        <input
                          value={perpDraft.quantity}
                          inputMode="decimal"
                          onChange={(event) =>
                            setPerpDraft((current) => ({
                              ...current,
                              quantity: Number(event.target.value),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Prix de marque
                        <input
                          value={perpDraft.markPrice}
                          inputMode="decimal"
                          onChange={(event) =>
                            setPerpDraft((current) => ({
                              ...current,
                              markPrice: Number(event.target.value),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Levier (×{HYPERLIQUID_PERP_POLICY.maxLeverage} max)
                        <select
                          value={perpDraft.leverage}
                          onChange={(event) =>
                            setPerpDraft((current) => ({
                              ...current,
                              leverage: Number(event.target.value),
                            }))
                          }
                        >
                          {Array.from(
                            { length: HYPERLIQUID_PERP_POLICY.maxLeverage },
                            (_, index) => index + 1,
                          ).map((value) => (
                            <option key={value} value={value}>
                              {value}x
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        PnL journalier (USD)
                        <input
                          value={perpDraft.dailyPnl}
                          inputMode="decimal"
                          onChange={(event) =>
                            setPerpDraft((current) => ({
                              ...current,
                              dailyPnl: Number(event.target.value),
                            }))
                          }
                        />
                      </label>
                    </div>
                  )}
                  <div className="button-row">
                    {perpUi.value === "form" && (
                      <button
                        className="button primary"
                        type="button"
                        onClick={preparePerpOrder}
                        disabled={readOnly || busy}
                      >
                        Préparer l'ordre
                      </button>
                    )}
                    {perpUi.value === "confirming" && (
                      <>
                        <button
                          className="button danger"
                          type="button"
                          onClick={confirmPerpOrder}
                          disabled={busy}
                        >
                          Confirmer {perpUi.context.draft?.side} {perpUi.context.draft?.quantity}{" "}
                          {perpUi.context.draft?.productId}
                        </button>
                        <button
                          className="button secondary"
                          type="button"
                          onClick={cancelPerpOrder}
                        >
                          Annuler
                        </button>
                      </>
                    )}
                    {perpUi.value === "result" && (
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => perpUiActor.send({ type: "SUBMISSION_DISMISSED" })}
                      >
                        Nouvel ordre
                      </button>
                    )}
                  </div>
                </section>
              </div>
            </div>
          </details>
        </div>
      )}

      {snapshot.value === "confirmingKill" && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="paper-card kill-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="kill-title"
          >
            <h2 id="kill-title">Engager le kill switch ?</h2>
            <p>
              Le cycle actif sera annulé ou réconcilié selon sa phase. Un reset
              autorisé sera requis avant tout redémarrage.
            </p>
            <div className="button-row">
              <button
                className="button danger"
                type="button"
                onClick={() =>
                  actor.send({ type: "KILL_CONFIRMED", permissions })
                }
              >
                Confirmer le kill
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => actor.send({ type: "KILL_CANCELLED" })}
              >
                Annuler
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
