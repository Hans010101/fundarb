import type { FundingQuote, Opportunity, ScanParameters } from "./types";

export const PERIODS_PER_YEAR_8H = 3 * 365;

export function normalizeFunding(rate: number, intervalHours: number): number {
  if (!Number.isFinite(rate) || !Number.isFinite(intervalHours) || intervalHours <= 0) {
    throw new RangeError("Funding rate and interval must be finite; interval must be positive");
  }
  return rate * (8 / intervalHours);
}

export function toApr(rate8h: number): number {
  return rate8h * PERIODS_PER_YEAR_8H;
}

export function estimateRoundTripCost(feeBpsPerLeg: number, slippageBpsPerLeg: number): number {
  if (feeBpsPerLeg < 0 || slippageBpsPerLeg < 0) throw new RangeError("Costs cannot be negative");
  return ((feeBpsPerLeg + slippageBpsPerLeg) * 4) / 10_000;
}

export function minHoldingPeriods(spread8h: number, totalCost: number, safetyFactor: number): number {
  if (spread8h <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil((totalCost * safetyFactor) / spread8h));
}

export function expectedNetApr(spread8h: number, totalCost: number, holdingPeriods: number): number {
  if (!Number.isInteger(holdingPeriods) || holdingPeriods <= 0) throw new RangeError("Holding periods must be positive");
  return (spread8h - totalCost / holdingPeriods) * PERIODS_PER_YEAR_8H;
}

export function basisPnl(basisOpen: number, basisClose: number, averagePrice: number): number {
  if (averagePrice <= 0) throw new RangeError("Average price must be positive");
  return (basisClose - basisOpen) / averagePrice;
}

function quoteLiquidity(quote: FundingQuote): number | null {
  return quote.volume24h && quote.volume24h > 0 ? quote.volume24h : null;
}

export function buildOpportunities(quotes: FundingQuote[], params: ScanParameters): Opportunity[] {
  const bySymbol = new Map<string, FundingQuote[]>();
  for (const quote of quotes) {
    const existing = bySymbol.get(quote.symbol) ?? [];
    existing.push(quote);
    bySymbol.set(quote.symbol, existing);
  }
  const totalCost = estimateRoundTripCost(params.feeBpsPerLeg, params.slippageBpsPerLeg);
  const output: Opportunity[] = [];

  for (const [symbol, symbolQuotes] of bySymbol) {
    if (symbolQuotes.length < 2) continue;
    for (const longQuote of symbolQuotes) {
      for (const shortQuote of symbolQuotes) {
        if (longQuote.exchange === shortQuote.exchange) continue;
        const spread = shortQuote.rate8h - longQuote.rate8h;
        if (spread <= 0) continue;
        const grossApr = toApr(spread);
        const minPeriods = minHoldingPeriods(spread, totalCost, params.safetyFactor);
        const netApr = expectedNetApr(spread, totalCost, params.holdingPeriods);
        const liquidityValues = [quoteLiquidity(longQuote), quoteLiquidity(shortQuote)].filter(
          (value): value is number => value !== null,
        );
        const liquidity = liquidityValues.length === 2 ? Math.min(...liquidityValues) : null;
        const reasons: string[] = [];
        if (minPeriods > params.maxHoldingPeriods) reasons.push(`回本需 ${minPeriods} 期，超过上限`);
        if (netApr < params.minEntryApr) reasons.push("成本后年化低于门槛");
        if (grossApr > 1) reasons.push("极端费率：需历史稳定性与盘口复核");
        if (longQuote.quoteAsset !== shortQuote.quoteAsset) reasons.push(`结算币不同（${longQuote.quoteAsset}/${shortQuote.quoteAsset}），禁止自动交易`);
        if (liquidity === null) reasons.push("缺少双边 24h 流动性数据");
        else if (liquidity < params.minVolumeUsd) reasons.push("双边流动性低于门槛");

        const bothPrices = longQuote.markPrice && shortQuote.markPrice;
        const averagePrice = bothPrices ? (longQuote.markPrice! + shortQuote.markPrice!) / 2 : null;
        const basisRate = averagePrice ? (longQuote.markPrice! - shortQuote.markPrice!) / averagePrice : null;
        // Ticker symbols are not globally unique. A very large price mismatch usually
        // means two venues use the same code for different assets or contract units.
        if (basisRate !== null && Math.abs(basisRate) > 0.2) continue;
        if (basisRate !== null && Math.abs(basisRate) > 0.03) reasons.push("跨所标记价格偏差过大，禁止自动交易");
        output.push({
          rank: 0,
          symbol,
          longExchange: longQuote.exchange,
          shortExchange: shortQuote.exchange,
          longQuoteAsset: longQuote.quoteAsset,
          shortQuoteAsset: shortQuote.quoteAsset,
          longRate8h: longQuote.rate8h,
          shortRate8h: shortQuote.rate8h,
          spread8h: spread,
          grossApr,
          expectedNetApr: netApr,
          minHoldingPeriods: minPeriods,
          estimatedRoundTripCost: totalCost,
          longMarkPrice: longQuote.markPrice,
          shortMarkPrice: shortQuote.markPrice,
          basisRate,
          liquidityUsd: liquidity,
          executable: reasons.length === 0,
          reasons,
          nextFundingTime: Math.min(
            ...[longQuote.nextFundingTime, shortQuote.nextFundingTime].filter((value): value is number => value !== null),
          ) || null,
        });
      }
    }
  }

  return output
    .sort((a, b) => Number(b.executable) - Number(a.executable) || b.expectedNetApr - a.expectedNetApr)
    .slice(0, 300)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}
