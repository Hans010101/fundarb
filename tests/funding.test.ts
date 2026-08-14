import { describe, expect, it } from "vitest";
import { basisPnl, buildOpportunities, buildSpotPerpOpportunities, estimateRoundTripCost, expectedNetApr, minHoldingPeriods, normalizeFunding, toApr } from "../src/lib/funding";
import type { FundingQuote, ScanParameters, SpotQuote } from "../src/lib/types";

describe("funding model", () => {
  it("normalizes 1h, 4h and 8h rates to 8h", () => {
    expect(normalizeFunding(0.0001, 1)).toBeCloseTo(0.0008, 12);
    expect(normalizeFunding(0.0001, 4)).toBeCloseTo(0.0002, 12);
    expect(normalizeFunding(0.0001, 8)).toBeCloseTo(0.0001, 12);
  });

  it("rejects invalid intervals", () => {
    expect(() => normalizeFunding(0.0001, 0)).toThrow(RangeError);
    expect(() => normalizeFunding(Number.NaN, 8)).toThrow(RangeError);
  });

  it("annualizes an 8h rate", () => expect(toApr(0.0001)).toBeCloseTo(0.1095, 12));

  it("includes all four fee and slippage legs", () => {
    expect(estimateRoundTripCost(5, 2)).toBeCloseTo(0.0028, 12);
  });

  it("uses the safety factor for break-even periods", () => {
    expect(minHoldingPeriods(0.0001, 0.0025, 2)).toBe(50);
    expect(minHoldingPeriods(0, 0.0025, 2)).toBe(Number.POSITIVE_INFINITY);
  });

  it("subtracts amortized round-trip cost from APR", () => {
    expect(expectedNetApr(0.0005, 0.002, 20)).toBeCloseTo(0.438, 12);
  });

  it("attributes converging negative basis as positive PnL", () => {
    expect(basisPnl(-10, 0, 100)).toBeCloseTo(0.1, 12);
  });
});

describe("opportunity builder", () => {
  const makeQuote = (exchange: FundingQuote["exchange"], rate8h: number): FundingQuote => ({
    exchange, symbol: "BTC", quoteAsset: "USDT", rate: rate8h, intervalHours: 8, rate8h, markPrice: 100, volume24h: 1_000_000_000,
    nextFundingTime: 2_000_000_000_000, intervalSource: "exchange_api",
  });
  const params: ScanParameters = { feeBpsPerLeg: 0, slippageBpsPerLeg: 0, safetyFactor: 2, holdingPeriods: 21, maxHoldingPeriods: 21, minEntryApr: 0.12, minVolumeUsd: 50_000_000 };

  it("selects low-rate long and high-rate short", () => {
    const result = buildOpportunities([makeQuote("Bybit", -0.0001), makeQuote("Bitget", 0.0002)], params);
    expect(result[0]).toMatchObject({ longExchange: "Bybit", shortExchange: "Bitget", executable: true });
    expect(result[0].spread8h).toBeCloseTo(0.0003, 12);
  });

  it("flags insufficient liquidity", () => {
    const low = { ...makeQuote("Bybit", -0.0001), volume24h: 1_000 };
    expect(buildOpportunities([low, makeQuote("Bitget", 0.0002)], params)[0].executable).toBe(false);
  });

  it("does not promote extreme one-period funding as a ready candidate", () => {
    const result = buildOpportunities([makeQuote("Bybit", -0.01), makeQuote("Bitget", 0.01)], params);
    expect(result[0].executable).toBe(false);
    expect(result[0].reasons).toContain("极端费率：需历史稳定性与盘口复核");
  });

  it("rejects same-ticker routes when prices indicate different assets or contract units", () => {
    const first = makeQuote("Bybit", -0.0001);
    const second = { ...makeQuote("HTX", 0.0002), markPrice: 0.5 };
    expect(buildOpportunities([first, second], params)).toHaveLength(0);
  });

  it("blocks automatic execution when cross-exchange basis is unusually wide", () => {
    const first = makeQuote("Bybit", -0.0001);
    const second = { ...makeQuote("HTX", 0.0002), markPrice: 96 };
    const [result] = buildOpportunities([first, second], params);
    expect(result.executable).toBe(false);
    expect(result.reasons).toContain("跨所标记价格偏差过大，禁止自动交易");
  });

  it("blocks automatic execution across different settlement assets", () => {
    const usdt = makeQuote("Bybit", -0.0001);
    const usdc = { ...makeQuote("Coinbase", 0.0002), quoteAsset: "USDC" as const };
    const [result] = buildOpportunities([usdt, usdc], params);
    expect(result.executable).toBe(false);
    expect(result.reasons).toContain("结算币不同（USDT/USDC），禁止自动交易");
  });
});

describe("spot and perpetual builder", () => {
  const params: ScanParameters = { feeBpsPerLeg: 0, slippageBpsPerLeg: 0, safetyFactor: 2, holdingPeriods: 21, maxHoldingPeriods: 21, minEntryApr: 0.12, minVolumeUsd: 50_000_000 };
  const spot: SpotQuote = { exchange: "Binance", symbol: "BTC", quoteAsset: "USDT", price: 100, volume24h: 1_000_000_000 };
  const perp = (rate8h: number): FundingQuote => ({ exchange: "Binance", symbol: "BTC", quoteAsset: "USDT", rate: rate8h, intervalHours: 8, rate8h, markPrice: 100, volume24h: 1_000_000_000, nextFundingTime: 2_000_000_000_000, intervalSource: "exchange_api" });

  it("uses long spot and short perpetual when funding is positive", () => {
    expect(buildSpotPerpOpportunities([perp(0.0002)], [spot], params)[0]).toMatchObject({ direction: "long_spot_short_perp", meetsThresholds: true });
  });

  it("requires borrow cost before judging negative-funding carry", () => {
    expect(buildSpotPerpOpportunities([perp(-0.0002)], [spot], params)[0]).toMatchObject({ direction: "long_perp_short_spot", expectedNetApr: null, minHoldingPeriods: null, meetsThresholds: false });
  });
});
