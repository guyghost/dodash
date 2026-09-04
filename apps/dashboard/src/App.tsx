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

const equityPath = (points: readonly { readonly t: number; readonly equity: number }[]): string => {
  if (points.length < 2) return "";
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
  return points
    .map((point, index) => {
      const x = (point.t - tMin) / spanT * width;
      const y = height - ((point.equity - eMin) / spanE) * (height - 12) - 6;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
};

function SectionHeading({
  index,
  title,
  detail,
}: {
  readonly index: string;
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <div className="section-heading">
      <span>{index}</span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </div>
  );
}

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
    snapshot.value === "connected" && account !== null && account.chainId === BASE_MAINNET_CHAIN_ID;
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
      <div className="card-topline">
        <span className="card-label blue-bg">WALLET BASE</span>
        <span
          className={`phase-badge ${connectedOnBase ? "online" : "offline"}`}
        >
          {badge}
        </span>
      </div>
      <h2>Session wallet</h2>
      {account === null ? (
        <p>
          Connecter le wallet Base pour signer sur `eip155:8453`. La clé reste
          dans le wallet ; la machine ne voit que l’adresse et la chaîne.
        </p>
      ) : (
        <p className="agent-meta">
          <code>{shortAddress(account.address)}</code> ·{" "}
          {account.chainId === BASE_MAINNET_CHAIN_ID
            ? "Base mainnet"
            : `Chaîne ${account.chainId}`}
        </p>
      )}
      <p className="next-wake" aria-live="polite">
        {capabilityLabel(capability)}
      </p>
      {lastError !== null && (
        <p className="error-note" role="alert">
          {lastError.code}
        </p>
      )}
      {snapshot.value === "failed" || snapshot.value === "disconnected" ? (
        <div className="button-row">
          <button
            className="button primary"
            type="button"
            onClick={onConnect}
          >
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
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummaryView | null>(null);
  const [agentName, setAgentName] = useState("btc-usd--multi");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [productId, setProductId] = useState("BTC-USD");
  const [timeframe, setTimeframe] = useState("FIVE_MINUTE");
  const [executionMode, setExecutionMode] = useState<"paper" | "live">("paper");
  const [strategyIds, setStrategyIds] = useState<readonly string[]>([
    "rsi-reversion",
    "ema-cross",
    "breakout",
  ]);
  const [liveConfirmation, setLiveConfirmation] = useState("");
  const gatewayRef = useRef<DashboardGateway | null>(null);
  const inFlightRef = useRef<string | null>(null);
  const pendingStartRef = useRef<StartConfiguration | undefined>(undefined);

  useEffect(() => {
    actor.start();
    const subscription = actor.subscribe(setSnapshot);
    return () => {
      subscription.unsubscribe();
    };
  }, [actor]);

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
        gateway.loadPortfolioSummary(target),
      ])
        .then(([nextAgent, nextCycles, nextPnl, nextPortfolio]) => {
          actor.send({
            type: "STATE_LOADED",
            remotePhase: nextAgent.phase,
            remoteUpdatedAt: nextAgent.updatedAt,
          });
          if (String(actor.getSnapshot().value) === "ready") {
            setAgent(nextAgent);
            setCycles(nextCycles);
            setPnlHistory(nextPnl);
            setPortfolioSummary(nextPortfolio);
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
          const [nextCycles, nextPnl, nextPortfolio] = await Promise.all([
            gateway.loadCycles(target),
            gateway.loadPnlHistory(target),
            gateway.loadPortfolioSummary(target),
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
            setPortfolioSummary(nextPortfolio);
          }
          pendingStartRef.current = undefined;
        })
        .catch(fail);
    }
  }, [actor, snapshot]);

  useEffect(() => {
    if (snapshot.value !== "ready") return;
    const timer = globalThis.setInterval(() => {
      if (actor.getSnapshot().value === "ready") {
        actor.send({ type: "REFRESH_REQUESTED" });
      }
    }, 15_000);
    return () => globalThis.clearInterval(timer);
  }, [actor, snapshot.value]);

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

  const issueCommand = (command: DashboardDirectCommand) => {
    if (command === "start") {
      pendingStartRef.current = createStartConfiguration({
        productId,
        timeframe,
        strategyIds,
        executionMode,
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
    if (gateway === null || target === null || draft === null || clientOrderId === null) {
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

  const busy =
    snapshot.value === "loading" ||
    snapshot.value === "refreshing" ||
    snapshot.value === "commanding";
  const ready =
    snapshot.value === "ready" ||
    snapshot.value === "confirmingKill" ||
    snapshot.value === "commanding" ||
    snapshot.value === "refreshing";
  const activePipeline = PIPELINE.findIndex((item) => item.phase === agent?.phase);
  const liveStartBlocked = executionMode === "live" && liveConfirmation !== "LIVE";
  const markPrice = agent?.lastCycle?.marketPrice ?? null;
  const equity =
    agent === null
      ? null
      : agent.portfolio.cash +
        agent.portfolio.positionQuantity *
          (markPrice ?? agent.portfolio.averagePrice);

  return (
    <main className="dashboard-shell">
      <header className="masthead">
        <p className="eyebrow">OBSERVATOIRE · EDGE COMPUTING · CLOUDFLARE</p>
        <div className="masthead-row">
          <div>
            <h1>
              DoDash
              <br />
              Trading Agent
            </h1>
            <p className="dek">
              Piloter la boucle, lire les signaux et garder chaque transition
              sous contrôle.
            </p>
          </div>
          <div className="connection-stamp" aria-live="polite">
            <span>SESSION</span>
            <strong>
              {ready ? "CONNECTÉE" : busy ? "CHARGEMENT" : "VERROUILLÉE"}
            </strong>
            <small>{snapshot.context.agentName ?? "aucune cible"}</small>
          </div>
        </div>
        <div className="rule" />
        {/* biome-ignore lint/a11y/useSemanticElements: conteneur de présentation, fieldset altérerait le rendu */}
        <div className="legend" role="group" aria-label="Légende système">
          <span><i className="orange" />Agent</span>
          <span><i className="teal" />Marché</span>
          <span><i className="purple" />Indicateurs</span>
          <span><i className="green" />Stratégies</span>
          <span><i className="red" />Décision</span>
          <span><i className="blue" />Persistance</span>
        </div>
      </header>

      <section>
        <SectionHeading
          index="00"
          title="WALLET BASE"
          detail="SIGNATURE LOCALE · EIP-155:8453"
        />
        <BaseWalletCard
          snapshot={wallet}
          onConnect={connectWallet}
          onDisconnect={disconnectWallet}
        />
      </section>

      {!ready ? (
        <section className="access-section">
          <SectionHeading
            index="01"
            title="ACCÈS"
            detail="OUVRIR UNE SESSION ÉPHÉMÈRE"
          />
          <div className="access-grid">
            <form className="paper-card access-card" onSubmit={connect}>
              <span className="card-label orange-bg">CONNEXION AU PROXY</span>
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
                  onClick={connectDemo}
                  disabled={busy}
                >
                  Voir la démo
                </button>
              </div>
            </form>
            <aside className="paper-card access-note">
              <span className="card-label green-bg">FRONTIÈRE SÛRE</span>
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
        <>
          <section>
            <SectionHeading
              index="01"
              title="ÉTAT DU BOT"
              detail="SOURCE : DURABLE OBJECT"
            />
            <div className="summary-grid">
              <article className="paper-card agent-card">
                <div className="card-topline">
                  <span className="card-label orange-bg">TRADING AGENT</span>
                  <span
                    className={`phase-badge ${agent.enabled ? "online" : "offline"}`}
                  >
                    {phaseLabel(agent.phase)}
                  </span>
                </div>
                <h2>{agent.configuration?.productId ?? "Non configuré"}</h2>
                <p className="agent-meta">
                  {agent.configuration?.executionMode.toUpperCase() ?? "—"} ·{" "}
                  {agent.configuration?.timeframe.replaceAll("_", " ") ?? "—"}
                </p>
                <div className="metric-grid">
                  <Metric
                    label="ÉQUITÉ"
                    value={equity === null ? "—" : money.format(equity)}
                    accent="blue-text"
                  />
                  <Metric
                    label="PNL JOUR"
                    value={money.format(agent.dailyPnl)}
                    accent={agent.dailyPnl >= 0 ? "green-text" : "red-text"}
                  />
                  <Metric
                    label="POSITION"
                    value={quantity.format(agent.portfolio.positionQuantity)}
                  />
                  <Metric
                    label="PRIX MOYEN"
                    value={money.format(agent.portfolio.averagePrice)}
                  />
                </div>
              </article>

              <article className="paper-card control-card">
                <div className="card-topline">
                  <span className="card-label red-bg">CONTRÔLE</span>
                  <span className="sync-time">
                    MAJ {compactDate.format(agent.updatedAt)}
                  </span>
                </div>
                <h2>Piloter la boucle</h2>
                <div className="control-buttons">
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => issueCommand("tick")}
                    disabled={busy || !agent.enabled}
                  >
                    Exécuter maintenant
                  </button>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => issueCommand("stop")}
                    disabled={busy || !agent.enabled}
                  >
                    Arrêter
                  </button>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => issueCommand("reset")}
                    disabled={
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
                    disabled={busy || !agent.enabled}
                  >
                    Kill switch
                  </button>
                </div>
                <p className="next-wake">
                  Prochain réveil :{" "}
                  {agent.nextWakeAt === null
                    ? "aucun"
                    : compactDate.format(agent.nextWakeAt)}
                </p>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => actor.send({ type: "DISCONNECT_REQUESTED" })}
                >
                  Fermer la session
                </button>
              </article>
            </div>
          </section>

          <section>
            <SectionHeading
              index="02"
              title="BOUCLE D’EXÉCUTION"
              detail="UNE TRANSITION À LA FOIS"
            />
            {/* biome-ignore lint/a11y/useSemanticElements: conteneur de présentation, fieldset altérerait le rendu */}
            <div className="pipeline" role="group" aria-label={`Phase courante : ${phaseLabel(agent.phase)}`}>
              {PIPELINE.map((item, index) => (
                <div
                  key={item.phase}
                  className={`pipeline-step ${item.color} ${
                    index === activePipeline ? "active" : ""
                  }`}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{item.label}</strong>
                  <small>{index === activePipeline ? "EN COURS" : "CONTRÔLÉ"}</small>
                </div>
              ))}
            </div>
          </section>

          <section className="detail-grid">
            <div>
              <SectionHeading
                index="03"
                title="STRATÉGIES"
                detail="SIGNAUX NORMALISÉS"
              />
              <div className="strategy-list">
                {(agent.configuration?.strategyIds ?? []).map((strategy) => (
                  <article className="paper-card strategy-card" key={strategy}>
                    <span className="card-label green-bg">ACTIVE</span>
                    <h3>{strategy}</h3>
                    <p>
                      Évalue les mêmes chandelles, puis transmet un signal typé
                      à l’allocateur.
                    </p>
                  </article>
                ))}
              </div>
            </div>
            <div>
              <SectionHeading
                index="04"
                title="INDICATEURS"
                detail="CALCUL PUR PROLOG"
              />
              <article className="paper-card indicator-card">
                {agent.indicators === null ? (
                  <p>Aucun snapshot calculé.</p>
                ) : (
                  <dl>
                    <div><dt>RSI</dt><dd>{agent.indicators.rsi.toFixed(2)}</dd></div>
                    <div><dt>EMA RAPIDE</dt><dd>{money.format(agent.indicators.emaFast)}</dd></div>
                    <div><dt>EMA LENTE</dt><dd>{money.format(agent.indicators.emaSlow)}</dd></div>
                    <div><dt>MACD</dt><dd>{agent.indicators.macd.toFixed(2)}</dd></div>
                    <div><dt>ATR</dt><dd>{agent.indicators.atr.toFixed(2)}</dd></div>
                  </dl>
                )}
              </article>
            </div>
          </section>

          {!agent.enabled && agent.phase === "stopped" && (
            <section>
              <SectionHeading
                index="05"
                title="DÉMARRAGE"
                detail="CONFIGURATION STRUCTURÉE"
              />
              <article className="paper-card start-card">
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
                          <option key={product} value={product}>{product}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={productId}
                        onChange={(event) =>
                          setProductId(event.target.value.toUpperCase())
                        }
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
                        selectExecutionMode(
                          event.target.value as "paper" | "live",
                        )
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
                    busy || strategyIds.length === 0 || liveStartBlocked
                  }
                >
                  Démarrer l’agent
                </button>
              </article>
            </section>
          )}

          <section>
            <SectionHeading
              index="06"
              title="HISTORIQUE"
              detail="CYCLES PERSISTÉS SQLITE"
            />
            <div className="paper-card table-card">
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
                          : `${(
                              (cycle.completedAt - cycle.triggeredAt) /
                              1_000
                            ).toFixed(1)} s`}
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

          <section>
            <SectionHeading
              index="07"
              title="PERFORMANCE"
              detail="PROJECTION SQLITE · LECTURE SEULE"
            />
            {pnlHistory === null ? null : (
              <>
                <article className="paper-card equity-card">
                  <div className="card-topline">
                    <span className="card-label blue-bg">COURBE D’ÉQUITÉ</span>
                    <span className="sync-time">
                      {pnlHistory.equityCurve.length} POINTS
                    </span>
                  </div>
                  {pnlHistory.equityCurve.length < 2 ? (
                    <p className="empty-state">Aucun point d’équité.</p>
                  ) : (
                    <svg
                      className="equity-chart"
                      viewBox="0 0 600 160"
                      preserveAspectRatio="none"
                      role="img"
                      aria-label="Courbe d’équité"
                    >
                      <path d={equityPath(pnlHistory.equityCurve)} />
                    </svg>
                  )}
                  {/* biome-ignore lint/a11y/useSemanticElements: groupe de badges de présentation */}
                  <div
                    className="protection-badges"
                    role="group"
                    aria-label="Position et protections"
                  >
                    {pnlHistory.openPosition === null ? (
                      <span className="outcome neutral">PLAT</span>
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
                </article>
                <div className="paper-card table-card">
                  <table>
                    <thead>
                      <tr>
                        <th>Cycle</th>
                        <th>Déclenché</th>
                        <th>Issue</th>
                        <th>Sens</th>
                        <th>Quantité</th>
                        <th>Prix exec.</th>
                        <th>PnL réalisé</th>
                        <th>Frais</th>
                        <th>Slippage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pnlHistory.cycles.map((cycle) => (
                        <tr key={cycle.cycleId}>
                          <td><code>{cycle.cycleId}</code></td>
                          <td>{compactDate.format(cycle.triggeredAt)}</td>
                          <td>
                            <span className={`outcome ${outcomeClass(cycle.outcome)}`}>
                              {cycle.outcome}
                            </span>
                          </td>
                          <td>{cycle.side ?? "—"}</td>
                          <td>{cycle.quantity === null ? "—" : quantity.format(cycle.quantity)}</td>
                          <td>{cycle.fillPrice === null ? "—" : money.format(cycle.fillPrice)}</td>
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
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {pnlHistory.cycles.length === 0 && (
                    <p className="empty-state">Aucun cycle dans la fenêtre.</p>
                  )}
                </div>
              </>
            )}
          </section>

          {portfolioSummary?.kind === "portfolio" && (
            <section>
              <SectionHeading
                index="08"
                title="PORTEFEUILLE"
                detail="VUE MULTI-PRODUITS · LECTURE SEULE"
              />
              <div className="portfolio-grid">
                {portfolioSummary.products.map((product) => (
                  <article className="paper-card product-card" key={product.productId}>
                    <div className="card-topline">
                      <span className="card-label teal-bg">{product.productId}</span>
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
                        value={money.format(product.grossExposure)}
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
                        : `${product.lastCycle.outcome} · ${compactDate.format(product.lastCycle.completedAt)}`}
                    </p>
                  </article>
                ))}
                <article className="paper-card consolidated-card">
                  <div className="card-topline">
                    <span className="card-label orange-bg">CONSOLIDÉ</span>
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
                      value={money.format(portfolioSummary.consolidated.grossExposure)}
                      accent="blue-text"
                    />
                    <Metric
                      label="PLAFOND PORTEFEUILLE"
                      value={money.format(portfolioSummary.consolidated.maxGrossExposure)}
                    />
                    <Metric
                      label="PNL JOUR CONSOLIDÉ"
                      value={money.format(portfolioSummary.consolidated.dailyPnl)}
                      accent={
                        portfolioSummary.consolidated.dailyPnl >= 0 ? "green-text" : "red-text"
                      }
                    />
                    <Metric
                      label="PLAFOND PERTE JOUR"
                      value={money.format(portfolioSummary.consolidated.maxDailyLoss)}
                    />
                  </div>
                  <p className="next-wake">
                    {portfolioSummary.products.length} produits · lecture seule, aucune décision
                    automatique
                  </p>
                </article>
              </div>
            </section>
          )}

          <section>
            <SectionHeading
              index="09"
              title="PERPÉTUELS · HYPERLIQUID"
              detail="ORDRE OPÉRATEUR · GARDES SERVEUR"
            />
            <article className="paper-card perp-card">
              <div className="card-topline">
                <span className="card-label blue-bg">INTENTION PERP</span>
                <span className="phase-badge offline">
                  {perpUi.value === "submitting" ? "SOUMISSION" : "MANUEL"}
                </span>
              </div>
              <h2>Ordre manuel sur l'enveloppe figée</h2>
              <p>
                Marchés BTC-PERP et ETH-PERP, levier ≤{" "}
                {HYPERLIQUID_PERP_POLICY.maxLeverage}x. Position et exposition
                sont lues sur le compte ; le PnL journalier reste votre entrée.
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
                        : perpUi.context.lastError?.code ?? "—"}
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
                        <option key={product} value={product}>{product}</option>
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
                        <option key={value} value={value}>{value}x</option>
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
                    disabled={busy}
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
                      Confirmer {perpUi.context.draft?.side} {" "}
                      {perpUi.context.draft?.quantity} {" "}
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
                    onClick={() =>
                      perpUiActor.send({ type: "SUBMISSION_DISMISSED" })
                    }
                  >
                    Nouvel ordre
                  </button>
                )}
              </div>
            </article>
          </section>
        </>
      )}

      {snapshot.value === "confirmingKill" && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="paper-card kill-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="kill-title"
          >
            <span className="card-label red-bg">ACTION TERMINALE</span>
            <h2 id="kill-title">Engager le kill switch ?</h2>
            <p>
              Le cycle actif sera annulé ou réconcilié selon sa phase. Un reset
              autorisé sera requis avant tout redémarrage.
            </p>
            <div className="button-row">
              <button
                className="button danger"
                type="button"
                onClick={() => actor.send({ type: "KILL_CONFIRMED", permissions })}
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
