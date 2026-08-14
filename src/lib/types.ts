export type ExchangeName =
  | "Binance"
  | "Bybit"
  | "OKX"
  | "Bitget"
  | "Hyperliquid"
  | "Gate.io"
  | "WEEX"
  | "HTX"
  | "Coinbase";

export interface FundingQuote {
  exchange: ExchangeName;
  symbol: string;
  quoteAsset: "USDT" | "USDC";
  rate: number;
  intervalHours: number;
  rate8h: number;
  markPrice: number | null;
  volume24h: number | null;
  nextFundingTime: number | null;
  intervalSource: "exchange_api" | "protocol_rule";
}

export interface SpotQuote {
  exchange: ExchangeName;
  symbol: string;
  quoteAsset: "USDT" | "USDC";
  price: number;
  volume24h: number | null;
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
  longQuoteAsset: "USDT" | "USDC";
  shortQuoteAsset: "USDT" | "USDC";
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

export interface SpotPerpOpportunity {
  rank: number;
  exchange: ExchangeName;
  symbol: string;
  quoteAsset: "USDT" | "USDC";
  direction: "long_spot_short_perp" | "long_perp_short_spot";
  fundingRate8h: number;
  grossApr: number;
  expectedNetApr: number | null;
  minHoldingPeriods: number | null;
  estimatedRoundTripCost: number;
  spotPrice: number;
  perpMarkPrice: number;
  basisRate: number;
  liquidityUsd: number | null;
  meetsThresholds: boolean;
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
  mode: "trading-terminal";
  params: ScanParameters;
  opportunities: Opportunity[];
  spotPerpOpportunities: SpotPerpOpportunity[];
  health: ExchangeHealth[];
  sourceCount: number;
  healthySourceCount: number;
  quoteCount: number;
  spotQuoteCount: number;
  spotExchangeCount: number;
  commonSymbolCount: number;
  warnings: string[];
}
