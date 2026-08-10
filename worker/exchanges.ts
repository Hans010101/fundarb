import { normalizeFunding } from "../src/lib/funding";
import type { ExchangeHealth, ExchangeName, FundingQuote } from "../src/lib/types";

const REQUEST_TIMEOUT_MS = 8_000;

interface FetchResult {
  quotes: FundingQuote[];
  health: ExchangeHealth;
}

type MarketEnv = Pick<Env, "EXECUTION_RELAY_URL" | "EXECUTION_RELAY_TOKEN">;

async function relayFetch(exchange: ExchangeName, url: string, env: MarketEnv, init?: RequestInit): Promise<Response> {
  const relayUrl = (env.EXECUTION_RELAY_URL as string).trim();
  if (!relayUrl) throw new Error("固定出口行情中继未配置");
  const sourceHeaders = new Headers(init?.headers);
  sourceHeaders.set("accept", "application/json");
  const headers = Object.fromEntries(sourceHeaders.entries());
  const response = await fetch(`${relayUrl.replace(/\/$/, "")}/v1/forward`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.EXECUTION_RELAY_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      exchange,
      url,
      method: init?.method === "POST" ? "POST" : "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + 2_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`固定出口中继 HTTP ${response.status}`);
  }
  return response;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function jsonFetch<T>(exchange: ExchangeName, url: string, env: MarketEnv, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  let directError: unknown;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (response.ok) return response.json<T>();
        directError = new Error(`HTTP ${response.status}`);
        const retryable = response.status === 429 || response.status >= 500;
        await response.body?.cancel();
        if (!retryable || attempt === 2) break;
      } catch (error) {
        directError = error;
        if (attempt === 2) break;
      }
      await pause(250 * (attempt + 1));
    }
    throw directError;
  } catch (finalDirectError) {
    if (!(env.EXECUTION_RELAY_URL as string).trim()) throw finalDirectError;
    try {
      return await (await relayFetch(exchange, url, env, { ...init, headers })).json<T>();
    } catch (relayError) {
      const directMessage = finalDirectError instanceof Error ? finalDirectError.message : "直接请求失败";
      const relayMessage = relayError instanceof Error ? relayError.message : "中继请求失败";
      throw new Error(`${directMessage}；${relayMessage}`);
    }
  }
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function nextBoundary(intervalHours: number): number {
  const intervalMs = intervalHours * 3_600_000;
  return Math.ceil(Date.now() / intervalMs) * intervalMs;
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
  quoteAsset: FundingQuote["quoteAsset"] = "USDT",
): FundingQuote {
  return { exchange, symbol, quoteAsset, rate, intervalHours, rate8h: normalizeFunding(rate, intervalHours), markPrice, volume24h, nextFundingTime, intervalSource };
}

async function measured(exchange: ExchangeName, loader: () => Promise<FundingQuote[]>): Promise<FetchResult> {
  const started = Date.now();
  try {
    const quotes = await loader();
    if (quotes.length === 0) throw new Error("接口成功但没有可用永续费率");
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

async function bybit(env: MarketEnv): Promise<FundingQuote[]> {
  const payload = await jsonFetch<BybitResponse>("Bybit", "https://api.bybit.com/v5/market/tickers?category=linear", env);
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

async function bitget(env: MarketEnv): Promise<FundingQuote[]> {
  const [funding, tickers] = await Promise.all([
    jsonFetch<BitgetResponse<BitgetFunding[]>>("Bitget", "https://api.bitget.com/api/v3/market/current-fund-rate?category=USDT-FUTURES", env),
    jsonFetch<BitgetResponse<BitgetTicker[]>>("Bitget", "https://api.bitget.com/api/v3/market/tickers?category=USDT-FUTURES", env),
  ]);
  if (funding.code !== "00000") throw new Error(funding.msg || `Bitget ${funding.code}`);
  if (tickers.code !== "00000") throw new Error(tickers.msg || `Bitget ${tickers.code}`);
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

async function hyperliquid(env: MarketEnv): Promise<FundingQuote[]> {
  const payload = await jsonFetch<[HyperMeta, HyperContext[]]>("Hyperliquid", "https://api.hyperliquid.xyz/info", env, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  const [meta, contexts] = payload;
  return meta.universe.flatMap((asset, index) => {
    const context = contexts[index];
    const rate = finiteNumber(context?.funding);
    if (asset.isDelisted || rate === null) return [];
    return [quote("Hyperliquid", asset.name, rate, 1, positiveNumber(context?.markPx), positiveNumber(context?.dayNtlVlm), nextBoundary(1), "protocol_rule", "USDC")];
  });
}

interface BinancePremium { symbol: string; markPrice?: string; lastFundingRate?: string; nextFundingTime?: number }
interface BinanceFundingInfo { symbol: string; fundingIntervalHours?: number }
interface BinanceTicker { symbol: string; quoteVolume?: string }

async function binance(env: MarketEnv): Promise<FundingQuote[]> {
  const [premium, fundingInfo, tickers] = await Promise.all([
    jsonFetch<BinancePremium[]>("Binance", "https://fapi.binance.com/fapi/v1/premiumIndex", env),
    jsonFetch<BinanceFundingInfo[]>("Binance", "https://fapi.binance.com/fapi/v1/fundingInfo", env),
    jsonFetch<BinanceTicker[]>("Binance", "https://fapi.binance.com/fapi/v1/ticker/24hr", env),
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

async function okx(env: MarketEnv): Promise<FundingQuote[]> {
  const tickers = await jsonFetch<OkxResponse<OkxTicker[]>>("OKX", "https://www.okx.com/api/v5/market/tickers?instType=SWAP", env);
  if (tickers.code !== "0") throw new Error(tickers.msg || `OKX ${tickers.code}`);
  const top = tickers.data
    .filter((item) => item.instId.endsWith("-USDT-SWAP"))
    .map((item) => ({ item, notional: (positiveNumber(item.last) ?? 0) * (positiveNumber(item.volCcy24h) ?? 0) }))
    .sort((a, b) => b.notional - a.notional)
    .slice(0, 40);
  const fundingRows = await Promise.allSettled(top.map(({ item }) => jsonFetch<OkxResponse<OkxFunding[]>>("OKX", `https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(item.instId)}`, env)));
  return fundingRows.flatMap((result, index) => {
    if (result.status === "rejected") return [];
    const response = result.value;
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

interface GateContract { name: string; funding_interval?: number; funding_next_apply?: number; status?: string }
interface GateTicker { contract: string; mark_price?: string; funding_rate?: string; volume_24h_quote?: string }

async function gate(env: MarketEnv): Promise<FundingQuote[]> {
  const [contracts, tickers] = await Promise.all([
    jsonFetch<GateContract[]>("Gate.io", "https://api.gateio.ws/api/v4/futures/usdt/contracts", env),
    jsonFetch<GateTicker[]>("Gate.io", "https://api.gateio.ws/api/v4/futures/usdt/tickers", env),
  ]);
  const contractMap = new Map(contracts.map((item) => [item.name, item]));
  return tickers.flatMap((item) => {
    const contract = contractMap.get(item.contract);
    const rate = finiteNumber(item.funding_rate);
    const interval = positiveNumber(contract?.funding_interval);
    if (!item.contract.endsWith("_USDT") || contract?.status !== "trading" || rate === null || interval === null) return [];
    return [quote("Gate.io", item.contract.replace(/_USDT$/, ""), rate, interval / 3_600, positiveNumber(item.mark_price), positiveNumber(item.volume_24h_quote), contract.funding_next_apply ? contract.funding_next_apply * 1_000 : null, "exchange_api")];
  });
}

interface WeexFunding { symbol: string; fundingRate?: string; collectCycle?: number; timestamp?: number }
interface WeexTicker { symbol: string; markPrice?: string; volume_24h?: string }

async function weex(env: MarketEnv): Promise<FundingQuote[]> {
  const [funding, tickers] = await Promise.all([
    jsonFetch<WeexFunding[]>("WEEX", "https://api-contract.weex.com/capi/v2/market/currentFundRate", env),
    jsonFetch<WeexTicker[]>("WEEX", "https://api-contract.weex.com/capi/v2/market/tickers", env),
  ]);
  const tickerMap = new Map(tickers.map((item) => [item.symbol.toLowerCase(), item]));
  return funding.flatMap((item) => {
    const raw = item.symbol.toLowerCase();
    const rate = finiteNumber(item.fundingRate);
    const cycleMinutes = positiveNumber(item.collectCycle);
    if (!raw.startsWith("cmt_") || !raw.endsWith("usdt") || rate === null || cycleMinutes === null) return [];
    const ticker = tickerMap.get(raw);
    return [quote("WEEX", raw.slice(4, -4).toUpperCase(), rate, cycleMinutes / 60, positiveNumber(ticker?.markPrice), positiveNumber(ticker?.volume_24h), finiteNumber(item.timestamp), "exchange_api")];
  });
}

interface HtxFunding { funding_rate?: string; contract_code: string; fee_asset?: string; funding_time?: string; next_funding_time?: string | null }
interface HtxContract { contract_code: string; contract_status?: number; settlement_period?: string }
interface HtxTicker { contract_code: string; close?: string; vol?: string }
interface HtxResponse<T> { status: string; err_msg?: string; data?: T; ticks?: T }

async function htx(env: MarketEnv): Promise<FundingQuote[]> {
  const [funding, contracts, tickers] = await Promise.all([
    jsonFetch<HtxResponse<HtxFunding[]>>("HTX", "https://api.hbdm.com/linear-swap-api/v1/swap_batch_funding_rate", env),
    jsonFetch<HtxResponse<HtxContract[]>>("HTX", "https://api.hbdm.com/linear-swap-api/v1/swap_contract_info", env),
    jsonFetch<HtxResponse<HtxTicker[]>>("HTX", "https://api.hbdm.com/v2/linear-swap-ex/market/detail/batch_merged", env),
  ]);
  if (funding.status !== "ok" || contracts.status !== "ok" || tickers.status !== "ok") throw new Error(funding.err_msg || contracts.err_msg || tickers.err_msg || "HTX 返回错误");
  const contractMap = new Map((contracts.data ?? []).map((item) => [item.contract_code, item]));
  const tickerMap = new Map((tickers.ticks ?? []).map((item) => [item.contract_code, item]));
  return (funding.data ?? []).flatMap((item) => {
    const contract = contractMap.get(item.contract_code);
    const ticker = tickerMap.get(item.contract_code);
    const rate = finiteNumber(item.funding_rate);
    const interval = positiveNumber(contract?.settlement_period);
    if (!item.contract_code.endsWith("-USDT") || item.fee_asset !== "USDT" || contract?.contract_status !== 1 || rate === null || interval === null) return [];
    return [quote("HTX", item.contract_code.slice(0, -5), rate, interval, positiveNumber(ticker?.close), positiveNumber(ticker?.vol), finiteNumber(item.next_funding_time) ?? finiteNumber(item.funding_time), "exchange_api")];
  });
}

interface CoinbaseInstrument {
  symbol: string;
  type?: string;
  base_asset_name?: string;
  quote_asset_name?: string;
  funding_interval?: string | number;
  trading_state?: string;
  notional_24hr?: string | number;
  quote?: { mark_price?: string | number; predicted_funding?: string | number; timestamp?: string };
}

async function coinbase(env: MarketEnv): Promise<FundingQuote[]> {
  const instruments = await jsonFetch<CoinbaseInstrument[]>("Coinbase", "https://api.international.coinbase.com/api/v1/instruments", env);
  return instruments.flatMap((item) => {
    const rate = finiteNumber(item.quote?.predicted_funding);
    const intervalNs = positiveNumber(item.funding_interval);
    if (item.type !== "PERP" || item.trading_state !== "TRADING" || item.quote_asset_name !== "USDC" || !item.base_asset_name || rate === null || intervalNs === null) return [];
    const intervalHours = intervalNs / 3_600_000_000_000;
    const timestamp = item.quote?.timestamp ? Date.parse(item.quote.timestamp) : Number.NaN;
    return [quote("Coinbase", item.base_asset_name, rate, intervalHours, positiveNumber(item.quote?.mark_price), positiveNumber(item.notional_24hr), Number.isFinite(timestamp) ? timestamp + intervalHours * 3_600_000 : nextBoundary(intervalHours), "exchange_api", "USDC")];
  });
}

export async function fetchAllExchanges(env: MarketEnv): Promise<{ quotes: FundingQuote[]; health: ExchangeHealth[] }> {
  const loaders: Array<() => Promise<FetchResult>> = [
    () => measured("Binance", () => binance(env)),
    () => measured("OKX", () => okx(env)),
    () => measured("Bybit", () => bybit(env)),
    () => measured("Hyperliquid", () => hyperliquid(env)),
    () => measured("Gate.io", () => gate(env)),
    () => measured("Bitget", () => bitget(env)),
    () => measured("WEEX", () => weex(env)),
    () => measured("HTX", () => htx(env)),
    () => measured("Coinbase", () => coinbase(env)),
  ];
  const results: FetchResult[] = [];
  for (let index = 0; index < loaders.length; index += 2) {
    results.push(...await Promise.all(loaders.slice(index, index + 2).map((load) => load())));
  }
  return { quotes: results.flatMap((result) => result.quotes), health: results.map((result) => result.health) };
}
