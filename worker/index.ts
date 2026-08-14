import { buildOpportunities, buildSpotPerpOpportunities } from "../src/lib/funding";
import type { ScanParameters, ScanResponse } from "../src/lib/types";
import { handleControlPlane } from "./control-plane";
import { fetchAllExchanges } from "./exchanges";
import { HttpError, json } from "./http";
import { relayAvailable, resolveRelayTransport } from "./relay";
import { handleTrading } from "./trading";

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

async function scan(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cacheKey = new Request(url.toString(), request);
  const cache = await caches.open("fundarb-market-scan");
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const params = parameters(url);
  const relayTransport = await resolveRelayTransport(env);
  const { quotes, spotQuotes, health } = await fetchAllExchanges(relayTransport);
  const exchangeCounts = new Map<string, number>();
  for (const item of quotes) exchangeCounts.set(item.symbol, (exchangeCounts.get(item.symbol) ?? 0) + 1);
  const warnings = [
    "费率是实时预测/当前值，不等于最终结算到账；实盘决策必须以结算流水对账。",
    "账户连接和双腿交易位于受保护的个人控制台；真实委托仍受紧急停止、环境、名义上限与固定 IP 中继约束。",
  ];
  for (const item of health.filter((entry) => !entry.ok)) warnings.push(`${item.exchange} 数据暂不可用：${item.error ?? "未知错误"}`);
  const body: ScanResponse = {
    generatedAt: Date.now(),
    staleAfterMs: 60_000,
    mode: "trading-terminal",
    params,
    opportunities: buildOpportunities(quotes, params),
    spotPerpOpportunities: buildSpotPerpOpportunities(quotes, spotQuotes, params),
    health,
    sourceCount: health.length,
    healthySourceCount: health.filter((entry) => entry.ok).length,
    quoteCount: quotes.length,
    spotQuoteCount: spotQuotes.length,
    spotExchangeCount: new Set(spotQuotes.map((item) => item.exchange)).size,
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
      if (url.pathname === "/api/health") {
        const relayTransport = await resolveRelayTransport(env);
        return json({
          ok: true,
          service: "fundarb-web",
          tradingControlPlane: true,
          relayConfigured: relayAvailable(relayTransport),
          relaySource: relayTransport.source,
          relayEgressIpv4: relayTransport.egressIpv4,
          relayExpiresAt: relayTransport.expiresAt,
          now: Date.now(),
        });
      }
      if (url.pathname === "/api/scan") return scan(request, env);
      if (url.pathname.startsWith("/api/admin/hedges")) return handleTrading(request, env, url.pathname);
      if (url.pathname.startsWith("/api/admin/")) return handleControlPlane(request, env, url.pathname);
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ event: "request_failed", path: url.pathname, error: error instanceof Error ? error.message : "unknown" }));
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      return json({ error: "服务暂时不可用，请稍后重试" }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
