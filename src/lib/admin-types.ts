import type { ExchangeName } from "./types";

export type ExecutionMode = "paper" | "testnet" | "live";

export interface TradingConnection {
  id: string;
  exchange: ExchangeName;
  environment: "testnet" | "live";
  label: string;
  fingerprint: string;
  enabled: boolean;
  verificationStatus: string;
  lastVerifiedAt: number | null;
  lastError: string | null;
  createdAt: number;
}

export interface HedgeRecord {
  id: string;
  mode: ExecutionMode;
  symbol: string;
  longConnectionId: string;
  shortConnectionId: string;
  longQuantity: string;
  shortQuantity: string;
  notionalUsd: string;
  hardLeg: "long" | "short";
  state: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ControlPlaneStatus {
  authenticated: true;
  relayConfigured: boolean;
  settings: {
    mode: ExecutionMode;
    executionEmergencyStop: boolean;
    orderSubmissionEnabled: boolean;
    liveEnabled: boolean;
    maxOrderNotionalUsd: number;
    maxEffectiveLeverage: number;
  };
  connections: TradingConnection[];
  hedges: HedgeRecord[];
}
