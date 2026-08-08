import { buildOpportunities } from "../src/lib/funding";
import type { ScanParameters, ScanResponse } from "../src/lib/types";
import { fetchAllExchanges } from "./exchanges";

interface Env { ASSETS: Fetcher }

const DEFAULTS: ScanParameters = {
  feeBpsPerLeg: 5.5,
  slippageBpsPerLeg: 2,
  safetyFactor: 2,
  holdingPeriods: 21,
  maxHoldingPeriods: 21,
  minEntryApr: 0.12,
  minVolumeUsd: 50_000_000,
};

function bounded(search: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = search.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function parameters(url: URL): ScanParameters {
  return {
    feeBpsPerLeg: bounded(url.searchParams, "feeBps", DEFAULTS.feeBpsPerLeg, 0, 50),
    slippageBpsPerLeg: bounded(url.searchParams, "slippageBps", DEFAULTS.slippageBpsPerLeg, 0, 100),
    safetyFactor: bounded(url.searchParams, "safety", DEFAULTS.safetyFactor, 1, 5),
    holdingPeriods: Math.round(bounded(url.searchParams, "periods", DEFAULTS.holdingPeriods, 1, 180)),
    maxHoldingPeriods: Math.round(bounded(url.searchParams, "maxPeriods", DEFAULTS.maxHoldingPeriods, 1, 180)),
    minEntryApr: bounded(url.searchParams, "minApr", DEFAULTS.minEntryApr, -1, 10),
    minVolumeUsd: bounded(url.searchParams, "minVolume", DEFAULTS.minVolumeUsd, 0, 10_000_000_000),
  };
}

function json(data: unknown, status = 200, cache = "no-store"): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": cache,
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

async function scan(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cacheKey = new Request(url.toString(), request);
  const cache = await caches.open("fundarb-market-scan");
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const params = parameters(url);
  const { quotes, health } = await fetchAllExchanges();
  const exchangeCounts = new Map<string, number>();
  for (const item of quotes) exchangeCounts.set(item.symbol, (exchangeCounts.get(item.symbol) ?? 0) + 1);
  const warnings = [
    "费率是实时预测/当前值，不等于最终结算到账；实盘决策必须以结算流水对账。",
    "当前看板只提供市场数据与成本模型，不保存交易密钥，也不会发送订单。",
  ];
  for (const item of health.filter((entry) => !entry.ok)) warnings.push(`${item.exchange} 数据暂不可用：${item.error ?? "未知错误"}`);
  const body: ScanResponse = {
    generatedAt: Date.now(),
    staleAfterMs: 60_000,
    mode: "market-data-only",
    params,
    opportunities: buildOpportunities(quotes, params),
    health,
    quoteCount: quotes.length,
    commonSymbolCount: [...exchangeCounts.values()].filter((count) => count >= 2).length,
    warnings,
  };
  const response = json(body, health.every((entry) => !entry.ok) ? 503 : 200, "public, max-age=20, s-maxage=20, stale-while-revalidate=40");
  if (response.ok) await cache.put(cacheKey, response.clone());
  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") return json({ ok: true, service: "fundarb-web", executionEnabled: false, now: Date.now() });
      if (url.pathname === "/api/scan") return scan(request);
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ event: "request_failed", path: url.pathname, error: error instanceof Error ? error.message : "unknown" }));
      return json({ error: "Upstream market data is temporarily unavailable" }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
