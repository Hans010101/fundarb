export type ExchangeName = "Binance" | "Bybit" | "OKX" | "Bitget" | "Hyperliquid";

export interface FundingQuote {
  exchange: ExchangeName;
  symbol: string;
  rate: number;
  intervalHours: number;
  rate8h: number;
  markPrice: number | null;
  volume24h: number | null;
  nextFundingTime: number | null;
  intervalSource: "exchange_api" | "protocol_rule";
}

export interface ExchangeHealth {
  exchange: ExchangeName;
  ok: boolean;
  quoteCount: number;
  latencyMs: number;
  error?: string;
}

export interface Opportunity {
  rank: number;
  symbol: string;
  longExchange: ExchangeName;
  shortExchange: ExchangeName;
  longRate8h: number;
  shortRate8h: number;
  spread8h: number;
  grossApr: number;
  expectedNetApr: number;
  minHoldingPeriods: number;
  estimatedRoundTripCost: number;
  longMarkPrice: number | null;
  shortMarkPrice: number | null;
  basisRate: number | null;
  liquidityUsd: number | null;
  executable: boolean;
  reasons: string[];
  nextFundingTime: number | null;
}

export interface ScanParameters {
  feeBpsPerLeg: number;
  slippageBpsPerLeg: number;
  safetyFactor: number;
  holdingPeriods: number;
  maxHoldingPeriods: number;
  minEntryApr: number;
  minVolumeUsd: number;
}

export interface ScanResponse {
  generatedAt: number;
  staleAfterMs: number;
  mode: "market-data-only";
  params: ScanParameters;
  opportunities: Opportunity[];
  health: ExchangeHealth[];
  quoteCount: number;
  commonSymbolCount: number;
  warnings: string[];
}
