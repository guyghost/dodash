export const DASHBOARD_REMOTE_PHASES = [
  "stopped",
  "scheduling",
  "waiting",
  "fetchingMarketData",
  "retryingMarketData",
  "computingIndicators",
  "evaluatingStrategies",
  "allocating",
  "checkingRisk",
  "persistingOrderIntent",
  "authorizing",
  "retryingAuthorization",
  "submittingOrder",
  "retryingExecution",
  "reconcilingOrder",
  "retryingReconciliation",
  "cancelling",
  "persisting",
  "retryingPersistence",
  "failed",
  "halted",
] as const;

export type DashboardRemotePhase = (typeof DASHBOARD_REMOTE_PHASES)[number];

export type DashboardCommand = "start" | "stop" | "reset" | "tick" | "kill";
export type DashboardDirectCommand = Exclude<DashboardCommand, "kill">;

export interface DashboardPermissions {
  readonly canControl: boolean;
  readonly canTrade: boolean;
}

export type DashboardErrorCode =
  | "INVALID_CREDENTIAL"
  | "INVALID_TARGET"
  | "INVALID_RESPONSE"
  | "CONTROL_PERMISSION_REQUIRED"
  | "TRADE_PERMISSION_REQUIRED"
  | "REQUEST_FAILED";

export interface DashboardError {
  readonly code: DashboardErrorCode;
  readonly retryable: boolean;
}

export interface DashboardSessionContext {
  readonly agentName: string | null;
  readonly credentialPresent: boolean;
  readonly remotePhase: DashboardRemotePhase | null;
  readonly pendingCommand: DashboardCommand | null;
  readonly remoteUpdatedAt: number | null;
  readonly lastError: DashboardError | null;
}

export type DashboardSessionEvent =
  | {
      readonly type: "CONNECT_REQUESTED";
      readonly agentName: string;
      readonly credentialPresent: boolean;
    }
  | {
      readonly type: "STATE_LOADED";
      readonly remotePhase: DashboardRemotePhase;
      readonly remoteUpdatedAt: number;
    }
  | { readonly type: "REFRESH_REQUESTED" }
  | {
      readonly type: "COMMAND_REQUESTED";
      readonly command: DashboardDirectCommand;
      readonly permissions: DashboardPermissions;
    }
  | {
      readonly type: "KILL_CONFIRMATION_REQUESTED";
      readonly permissions: DashboardPermissions;
    }
  | { readonly type: "KILL_CONFIRMED"; readonly permissions: DashboardPermissions }
  | { readonly type: "KILL_CANCELLED" }
  | {
      readonly type: "COMMAND_SUCCEEDED";
      readonly remotePhase: DashboardRemotePhase;
      readonly remoteUpdatedAt: number;
    }
  | { readonly type: "REQUEST_FAILED"; readonly error: DashboardError }
  | { readonly type: "RETRY_REQUESTED" }
  | { readonly type: "DISCONNECT_REQUESTED" };

export interface DashboardSessionInput {
  readonly defaultAgentName?: string;
}
