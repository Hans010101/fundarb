import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? "8788");
const RELAY_TOKEN = process.env.FUNDARB_RELAY_TOKEN ?? "";
const MAX_BODY_BYTES = 32_768;
const MAX_FORWARD_BODY_BYTES = 16_384;
const REQUEST_TTL_MS = 15_000;
const seenRequestIds = new Map();

const ALLOWLIST = new Map([
  ["fapi.binance.com", new Map([["POST", ["/fapi/v1/order"]], ["GET", ["/fapi/v2/account"]]])],
  ["testnet.binancefuture.com", new Map([["POST", ["/fapi/v1/order"]], ["GET", ["/fapi/v2/account"]]])],
  ["api.bybit.com", new Map([["POST", ["/v5/order/create"]], ["GET", ["/v5/account/wallet-balance"]]])],
  ["api-testnet.bybit.com", new Map([["POST", ["/v5/order/create"]], ["GET", ["/v5/account/wallet-balance"]]])],
  ["www.okx.com", new Map([["POST", ["/api/v5/trade/order"]], ["GET", ["/api/v5/account/balance"]]])],
  ["api.bitget.com", new Map([["POST", ["/api/v2/mix/order/place-order"]], ["GET", ["/api/v2/mix/account/accounts"]]])],
]);

const HEADER_ALLOWLIST = new Set([
  "content-type", "x-mbx-apikey", "x-bapi-api-key", "x-bapi-timestamp", "x-bapi-recv-window", "x-bapi-sign",
  "ok-access-key", "ok-access-timestamp", "ok-access-passphrase", "ok-access-sign", "x-simulated-trading",
  "access-key", "access-timestamp", "access-passphrase", "access-sign", "locale",
]);

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function validateForwardRequest(payload) {
  if (!payload || typeof payload !== "object") throw new Error("请求结构无效");
  if (typeof payload.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.requestId)) throw new Error("requestId 无效");
  if (payload.method !== "GET" && payload.method !== "POST") throw new Error("方法不在白名单");
  if (typeof payload.url !== "string") throw new Error("目标地址无效");
  const target = new URL(payload.url);
  if (target.protocol !== "https:" || target.port || target.username || target.password) throw new Error("只允许标准 HTTPS 目标");
  const methods = ALLOWLIST.get(target.hostname);
  const paths = methods?.get(payload.method);
  if (!paths?.includes(target.pathname)) throw new Error("目标主机或接口不在白名单");
  if (payload.body !== null && typeof payload.body !== "string") throw new Error("请求体必须是字符串或 null");
  if ((payload.body?.length ?? 0) > MAX_FORWARD_BODY_BYTES) throw new Error("转发请求体过大");
  const headers = {};
  for (const [key, value] of Object.entries(payload.headers ?? {})) {
    const normalized = key.toLowerCase();
    if (!HEADER_ALLOWLIST.has(normalized) || typeof value !== "string" || value.length > 4096) throw new Error(`请求头不在白名单：${key}`);
    headers[key] = value;
  }
  return { target, headers };
}

function cleanupSeen(now) {
  for (const [id, expiresAt] of seenRequestIds) if (expiresAt <= now) seenRequestIds.delete(id);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

export function createRelayServer() {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, service: "fundarb-execution-relay" });
      if (request.method !== "POST" || request.url !== "/v1/forward") return send(response, 404, { error: "接口不存在" });
      const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
      if (!RELAY_TOKEN || !safeEqual(bearer, RELAY_TOKEN)) return send(response, 401, { error: "中继凭证无效" });
      const payload = JSON.parse(await readBody(request));
      const { target, headers } = validateForwardRequest(payload);
      const now = Date.now();
      cleanupSeen(now);
      if (seenRequestIds.has(payload.requestId)) return send(response, 409, { error: "重复 requestId 已拒绝" });
      seenRequestIds.set(payload.requestId, now + REQUEST_TTL_MS);
      const upstream = await fetch(target, { method: payload.method, headers, body: payload.method === "POST" ? (payload.body ?? "") : undefined, signal: AbortSignal.timeout(8_000) });
      const upstreamBody = (await upstream.text()).slice(0, MAX_FORWARD_BODY_BYTES);
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(upstreamBody);
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : "中继请求失败" });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!RELAY_TOKEN) throw new Error("FUNDARB_RELAY_TOKEN is required");
  createRelayServer().listen(PORT, "127.0.0.1", () => {
    console.log(JSON.stringify({ event: "relay_started", port: PORT }));
  });
}
