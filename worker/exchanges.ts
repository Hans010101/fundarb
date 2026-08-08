import { normalizeFunding } from "../src/lib/funding";
import type { ExchangeHealth, ExchangeName, FundingQuote } from "../src/lib/types";

const REQUEST_TIMEOUT_MS = 8_000;

interface FetchResult {
  quotes: FundingQuote[];
  health: ExchangeHealth;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", "user-agent": "FundArb/0.1 market-data", ...init?.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json<T>();
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function quote(
  exchange: ExchangeName,
  symbol: string,
  rate: number,
  intervalHours: number,
  markPrice: number | null,
  volume24h: number | null,
  nextFundingTime: number | null,
  intervalSource: FundingQuote["intervalSource"],
): FundingQuote {
  return { exchange, symbol, rate, intervalHours, rate8h: normalizeFunding(rate, intervalHours), markPrice, volume24h, nextFundingTime, intervalSource };
}

async function measured(exchange: ExchangeName, loader: () => Promise<FundingQuote[]>): Promise<FetchResult> {
  const started = Date.now();
  try {
    const quotes = await loader();
    return { quotes, health: { exchange, ok: true, quoteCount: quotes.length, latencyMs: Date.now() - started } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown upstream error";
    return { quotes: [], health: { exchange, ok: false, quoteCount: 0, latencyMs: Date.now() - started, error: message } };
  }
}

interface BybitTicker {
  symbol: string;
  markPrice?: string;
  turnover24h?: string;
  fundingRate?: string;
  fundingIntervalHour?: string;
  nextFundingTime?: string;
}

interface BybitResponse { retCode: number; retMsg: string; result: { list: BybitTicker[] } }

async function bybit(): Promise<FundingQuote[]> {
  const payload = await jsonFetch<BybitResponse>("https://api.bybit.com/v5/market/tickers?category=linear");
  if (payload.retCode !== 0) throw new Error(payload.retMsg || `Bybit ${payload.retCode}`);
  return payload.result.list.flatMap((item) => {
    const rate = finiteNumber(item.fundingRate);
    const interval = positiveNumber(item.fundingIntervalHour);
    if (!item.symbol.endsWith("USDT") || rate === null || interval === null) return [];
    return [quote("Bybit", item.symbol.slice(0, -4), rate, interval, positiveNumber(item.markPrice), positiveNumber(item.turnover24h), finiteNumber(item.nextFundingTime), "exchange_api")];
  });
}

interface BitgetFunding { symbol: string; fundingRate?: string; fundingRateInterval?: string; nextUpdate?: string }
interface BitgetTicker { symbol: string; markPrice?: string; turnover24h?: string }
interface BitgetResponse<T> { code: string; msg: string; data: T }

async function bitget(): Promise<FundingQuote[]> {
  const [funding, tickers] = await Promise.all([
    jsonFetch<BitgetResponse<BitgetFunding[]>>("https://api.bitget.com/api/v3/market/current-fund-rate?category=USDT-FUTURES"),
    jsonFetch<BitgetResponse<BitgetTicker[]>>("https://api.bitget.com/api/v3/market/tickers?category=USDT-FUTURES"),
  ]);
  if (funding.code !== "00000") throw new Error(funding.msg || `Bitget ${funding.code}`);
  const tickerMap = new Map(tickers.data.map((item) => [item.symbol, item]));
  return funding.data.flatMap((item) => {
    const rate = finiteNumber(item.fundingRate);
    const interval = positiveNumber(item.fundingRateInterval);
    if (!item.symbol.endsWith("USDT") || rate === null || interval === null) return [];
    const ticker = tickerMap.get(item.symbol);
    return [quote("Bitget", item.symbol.slice(0, -4), rate, interval, positiveNumber(ticker?.markPrice), positiveNumber(ticker?.turnover24h), finiteNumber(item.nextUpdate), "exchange_api")];
  });
}

interface HyperMeta { universe: Array<{ name: string; isDelisted?: boolean }> }
interface HyperContext { funding?: string; markPx?: string; dayNtlVlm?: string }

async function hyperliquid(): Promise<FundingQuote[]> {
  const payload = await jsonFetch<[HyperMeta, HyperContext[]]>("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  const [meta, contexts] = payload;
  const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  return meta.universe.flatMap((asset, index) => {
    const context = contexts[index];
    const rate = finiteNumber(context?.funding);
    if (asset.isDelisted || rate === null) return [];
    return [quote("Hyperliquid", asset.name, rate, 1, positiveNumber(context?.markPx), positiveNumber(context?.dayNtlVlm), nextHour, "protocol_rule")];
  });
}

interface BinancePremium { symbol: string; markPrice?: string; lastFundingRate?: string; nextFundingTime?: number }
interface BinanceFundingInfo { symbol: string; fundingIntervalHours?: number }
interface BinanceTicker { symbol: string; quoteVolume?: string }

async function binance(): Promise<FundingQuote[]> {
  const [premium, fundingInfo, tickers] = await Promise.all([
    jsonFetch<BinancePremium[]>("https://fapi.binance.com/fapi/v1/premiumIndex"),
    jsonFetch<BinanceFundingInfo[]>("https://fapi.binance.com/fapi/v1/fundingInfo"),
    jsonFetch<BinanceTicker[]>("https://fapi.binance.com/fapi/v1/ticker/24hr"),
  ]);
  const intervalMap = new Map(fundingInfo.map((item) => [item.symbol, item.fundingIntervalHours]));
  const volumeMap = new Map(tickers.map((item) => [item.symbol, positiveNumber(item.quoteVolume)]));
  return premium.flatMap((item) => {
    const rate = finiteNumber(item.lastFundingRate);
    if (!item.symbol.endsWith("USDT") || rate === null) return [];
    const interval = intervalMap.get(item.symbol) ?? 8;
    return [quote("Binance", item.symbol.slice(0, -4), rate, interval, positiveNumber(item.markPrice), volumeMap.get(item.symbol) ?? null, finiteNumber(item.nextFundingTime), intervalMap.has(item.symbol) ? "exchange_api" : "protocol_rule")];
  });
}

interface OkxTicker { instId: string; last?: string; volCcy24h?: string }
interface OkxFunding { instId: string; fundingRate?: string; prevFundingTime?: string; nextFundingTime?: string }
interface OkxResponse<T> { code: string; msg: string; data: T }

async function okx(): Promise<FundingQuote[]> {
  const tickers = await jsonFetch<OkxResponse<OkxTicker[]>>("https://www.okx.com/api/v5/market/tickers?instType=SWAP");
  if (tickers.code !== "0") throw new Error(tickers.msg || `OKX ${tickers.code}`);
  const top = tickers.data
    .filter((item) => item.instId.endsWith("-USDT-SWAP"))
    .map((item) => ({ item, notional: (positiveNumber(item.last) ?? 0) * (positiveNumber(item.volCcy24h) ?? 0) }))
    .sort((a, b) => b.notional - a.notional)
    .slice(0, 30);
  const fundingRows = await Promise.all(top.map(({ item }) => jsonFetch<OkxResponse<OkxFunding[]>>(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(item.instId)}`)));
  return fundingRows.flatMap((response, index) => {
    const row = response.data[0];
    const ticker = top[index];
    const rate = finiteNumber(row?.fundingRate);
    const previous = finiteNumber(row?.prevFundingTime);
    const next = finiteNumber(row?.nextFundingTime);
    const interval = previous !== null && next !== null ? (next - previous) / 3_600_000 : null;
    if (response.code !== "0" || !row || rate === null || interval === null || interval <= 0) return [];
    return [quote("OKX", row.instId.replace(/-USDT-SWAP$/, ""), rate, interval, positiveNumber(ticker.item.last), ticker.notional || null, next, "exchange_api")];
  });
}

export async function fetchAllExchanges(): Promise<{ quotes: FundingQuote[]; health: ExchangeHealth[] }> {
  const results = await Promise.all([
    measured("Binance", binance),
    measured("Bybit", bybit),
    measured("OKX", okx),
    measured("Bitget", bitget),
    measured("Hyperliquid", hyperliquid),
  ]);
  return { quotes: results.flatMap((result) => result.quotes), health: results.map((result) => result.health) };
}
