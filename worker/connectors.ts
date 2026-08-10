import { signL1Action } from "@nktkas/hyperliquid/signing";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { privateKeyToAccount } from "viem/accounts";
import { HttpError } from "./http";

export const SUPPORTED_EXCHANGES = ["Binance", "Bybit", "OKX", "Bitget", "Hyperliquid", "Gate.io", "WEEX", "HTX", "Coinbase"] as const;
export type TradingExchange = (typeof SUPPORTED_EXCHANGES)[number];
export type TradingEnvironment = "testnet" | "live";

export interface DecryptedConnection {
  id: string;
  exchange: TradingExchange;
  environment: TradingEnvironment;
  apiKey: string;
  apiSecret: string;
  passphrase: string | null;
}

export interface SignedRelayRequest {
  requestId: string;
  exchange: TradingExchange;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string | null;
}

export interface OrderLeg {
  symbol: string;
  direction: "long" | "short";
  action: "open" | "close" | "rollback";
  quantity: string;
  clientOrderId: string;
}

const textEncoder = new TextEncoder();

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmac(secret: string | Uint8Array<ArrayBuffer>, value: string, format: "hex" | "base64", hash: "SHA-256" | "SHA-512" = "SHA-256"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", typeof secret === "string" ? textEncoder.encode(secret) : secret, { name: "HMAC", hash }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return format === "hex" ? bytesToHex(signature) : bytesToBase64(signature);
}

async function sha512(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-512", textEncoder.encode(value)));
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", textEncoder.encode(value));
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new HttpError(400, "Coinbase API Secret 必须是有效的 Base64 字符串");
  }
}

function normalizeSymbol(value: string): string {
  const symbol = value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/USDT$/, "");
  if (!/^[A-Z0-9]{2,18}$/.test(symbol)) throw new HttpError(400, "交易对格式无效");
  return symbol;
}

function orderSide(leg: OrderLeg): { buy: boolean; reduceOnly: boolean } {
  const reduceOnly = leg.action !== "open";
  const buy = leg.direction === "long" ? !reduceOnly : reduceOnly;
  return { buy, reduceOnly };
}

function positiveQuantity(value: string): string {
  const quantity = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(quantity) || Number(quantity) <= 0) throw new HttpError(400, "委托数量必须为正数");
  return quantity;
}

function baseUrl(connection: DecryptedConnection): string {
  if (connection.exchange === "Binance") return connection.environment === "testnet" ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
  if (connection.exchange === "Bybit") return connection.environment === "testnet" ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
  if (connection.exchange === "OKX") return "https://www.okx.com";
  if (connection.exchange === "Bitget") return "https://api.bitget.com";
  if (connection.exchange === "Gate.io") return connection.environment === "testnet" ? "https://fx-api-testnet.gateio.ws" : "https://api.gateio.ws";
  if (connection.exchange === "Hyperliquid") return connection.environment === "testnet" ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz";
  if (connection.exchange === "WEEX") return "https://api-contract.weex.com";
  if (connection.exchange === "HTX") return "https://api.hbdm.com";
  return connection.environment === "testnet" ? "https://api-n5e1.coinbase.com" : "https://api.international.coinbase.com";
}

async function signedBinance(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  const { buy, reduceOnly } = orderSide(leg);
  const params = new URLSearchParams({
    symbol: `${normalizeSymbol(leg.symbol)}USDT`,
    side: buy ? "BUY" : "SELL",
    type: "MARKET",
    quantity: leg.quantity,
    reduceOnly: String(reduceOnly),
    newClientOrderId: leg.clientOrderId,
    recvWindow: "5000",
    timestamp: String(Date.now()),
  });
  params.set("signature", await hmac(connection.apiSecret, params.toString(), "hex"));
  return {
    requestId: crypto.randomUUID(), exchange: "Binance", method: "POST",
    url: `${baseUrl(connection)}/fapi/v1/order?${params}`,
    headers: { "X-MBX-APIKEY": connection.apiKey, "content-type": "application/x-www-form-urlencoded" }, body: "",
  };
}

async function signedBybit(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  const { buy, reduceOnly } = orderSide(leg);
  const timestamp = String(Date.now());
  const recvWindow = "5000";
  const body = JSON.stringify({
    category: "linear", symbol: `${normalizeSymbol(leg.symbol)}USDT`, side: buy ? "Buy" : "Sell",
    orderType: "Market", qty: leg.quantity, positionIdx: 0, orderLinkId: leg.clientOrderId, reduceOnly,
  });
  return {
    requestId: crypto.randomUUID(), exchange: "Bybit", method: "POST", url: `${baseUrl(connection)}/v5/order/create`, body,
    headers: {
      "X-BAPI-API-KEY": connection.apiKey, "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": await hmac(connection.apiSecret, `${timestamp}${connection.apiKey}${recvWindow}${body}`, "hex"),
      "content-type": "application/json",
    },
  };
}

async function signedOkx(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  if (!connection.passphrase) throw new HttpError(400, "OKX 连接缺少 Passphrase");
  const { buy, reduceOnly } = orderSide(leg);
  const path = "/api/v5/trade/order";
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({
    instId: `${normalizeSymbol(leg.symbol)}-USDT-SWAP`, tdMode: "cross", clOrdId: leg.clientOrderId,
    side: buy ? "buy" : "sell", ordType: "market", sz: leg.quantity, reduceOnly,
  });
  return {
    requestId: crypto.randomUUID(), exchange: "OKX", method: "POST", url: `${baseUrl(connection)}${path}`, body,
    headers: {
      "OK-ACCESS-KEY": connection.apiKey, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": connection.passphrase,
      "OK-ACCESS-SIGN": await hmac(connection.apiSecret, `${timestamp}POST${path}${body}`, "base64"),
      "content-type": "application/json",
      ...(connection.environment === "testnet" ? { "x-simulated-trading": "1" } : {}),
    },
  };
}

async function signedBitget(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  if (!connection.passphrase) throw new HttpError(400, "Bitget 连接缺少 Passphrase");
  const { buy, reduceOnly } = orderSide(leg);
  const path = "/api/v2/mix/order/place-order";
  const timestamp = String(Date.now());
  const body = JSON.stringify({
    symbol: `${normalizeSymbol(leg.symbol)}USDT`, productType: "USDT-FUTURES", marginMode: "crossed", marginCoin: "USDT",
    size: leg.quantity, side: buy ? "buy" : "sell", orderType: "market", clientOid: leg.clientOrderId,
    reduceOnly: reduceOnly ? "YES" : "NO",
  });
  return {
    requestId: crypto.randomUUID(), exchange: "Bitget", method: "POST", url: `${baseUrl(connection)}${path}`, body,
    headers: {
      "ACCESS-KEY": connection.apiKey, "ACCESS-TIMESTAMP": timestamp, "ACCESS-PASSPHRASE": connection.passphrase,
      "ACCESS-SIGN": await hmac(connection.apiSecret, `${timestamp}POST${path}${body}`, "base64"),
      "content-type": "application/json", locale: "zh-CN",
      ...(connection.environment === "testnet" ? { paptrading: "1" } : {}),
    },
  };
}

async function signedGate(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  const { buy, reduceOnly } = orderSide(leg);
  const path = "/api/v4/futures/usdt/orders";
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const quantity = positiveQuantity(leg.quantity);
  const body = JSON.stringify({
    contract: `${normalizeSymbol(leg.symbol)}_USDT`,
    size: buy ? quantity : `-${quantity}`,
    price: "0",
    tif: "ioc",
    text: `t-${leg.clientOrderId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-26)}`,
    reduce_only: reduceOnly,
  });
  const signature = await hmac(connection.apiSecret, `POST\n${path}\n\n${await sha512(body)}\n${timestamp}`, "hex", "SHA-512");
  return {
    requestId: crypto.randomUUID(), exchange: "Gate.io", method: "POST", url: `${baseUrl(connection)}${path}`, body,
    headers: { KEY: connection.apiKey, Timestamp: timestamp, SIGN: signature, "content-type": "application/json" },
  };
}

async function signedWeex(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  if (!connection.passphrase) throw new HttpError(400, "WEEX 连接缺少 Passphrase");
  const { buy } = orderSide(leg);
  const path = connection.environment === "testnet" ? "/capi/v3/sim/order" : "/capi/v3/order";
  const timestamp = String(Date.now());
  const body = JSON.stringify({
    symbol: `${normalizeSymbol(leg.symbol)}${connection.environment === "testnet" ? "SUSDT" : "USDT"}`,
    side: buy ? "BUY" : "SELL",
    positionSide: leg.direction === "long" ? "LONG" : "SHORT",
    type: "MARKET",
    quantity: positiveQuantity(leg.quantity),
    newClientOrderId: leg.clientOrderId,
  });
  return {
    requestId: crypto.randomUUID(), exchange: "WEEX", method: "POST", url: `${baseUrl(connection)}${path}`, body,
    headers: {
      "ACCESS-KEY": connection.apiKey,
      "ACCESS-SIGN": await hmac(connection.apiSecret, `${timestamp}POST${path}${body}`, "base64"),
      "ACCESS-PASSPHRASE": connection.passphrase,
      "ACCESS-TIMESTAMP": timestamp,
      "content-type": "application/json",
    },
  };
}

async function htxRequest(connection: DecryptedConnection, path: string, body: string): Promise<SignedRelayRequest> {
  const timestamp = new Date().toISOString().slice(0, 19);
  const params = new URLSearchParams({ AccessKeyId: connection.apiKey, SignatureMethod: "HmacSHA256", SignatureVersion: "2", Timestamp: timestamp });
  const signature = await hmac(connection.apiSecret, `POST\napi.hbdm.com\n${path}\n${params}`, "base64");
  params.set("Signature", signature);
  return { requestId: crypto.randomUUID(), exchange: "HTX", method: "POST", url: `${baseUrl(connection)}${path}?${params}`, headers: { "content-type": "application/json" }, body };
}

async function numericClientOrderId(value: string): Promise<number> {
  const bytes = new Uint8Array(await sha256(value));
  let result = 0;
  for (let index = 0; index < 6; index += 1) result = result * 256 + bytes[index];
  return result + 1;
}

async function signedHtx(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  if (connection.environment !== "live") throw new HttpError(400, "HTX 当前仅支持主网账户");
  const { buy } = orderSide(leg);
  const volume = Number(positiveQuantity(leg.quantity));
  if (!Number.isSafeInteger(volume)) throw new HttpError(400, "HTX 委托数量必须填写正整数合约张数");
  const body = JSON.stringify({
    contract_code: `${normalizeSymbol(leg.symbol)}-USDT`,
    direction: buy ? "buy" : "sell",
    offset: leg.action === "open" ? "open" : "close",
    lever_rate: 1,
    volume,
    order_price_type: "optimal_5",
    client_order_id: await numericClientOrderId(leg.clientOrderId),
  });
  return htxRequest(connection, "/linear-swap-api/v1/swap_order", body);
}

async function signedCoinbase(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  if (!connection.passphrase) throw new HttpError(400, "Coinbase 连接缺少 Passphrase");
  const { buy, reduceOnly } = orderSide(leg);
  const path = "/api/v1/orders";
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const body = JSON.stringify({
    client_order_id: leg.clientOrderId,
    side: buy ? "BUY" : "SELL",
    size: positiveQuantity(leg.quantity),
    instrument: `${normalizeSymbol(leg.symbol)}-PERP`,
    type: "MARKET",
    close_only: reduceOnly,
  });
  return {
    requestId: crypto.randomUUID(), exchange: "Coinbase", method: "POST", url: `${baseUrl(connection)}${path}`, body,
    headers: {
      "CB-ACCESS-KEY": connection.apiKey,
      "CB-ACCESS-PASSPHRASE": connection.passphrase,
      "CB-ACCESS-TIMESTAMP": timestamp,
      "CB-ACCESS-SIGN": await hmac(base64Bytes(connection.apiSecret), `${timestamp}POST${path}${body}`, "base64"),
      "content-type": "application/json",
    },
  };
}

interface HyperMeta { universe: Array<{ name: string; szDecimals: number; isDelisted?: boolean }> }
interface HyperContext { markPx?: string }

function hyperAccount(connection: DecryptedConnection) {
  const privateKey = connection.apiSecret.trim();
  if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) throw new HttpError(400, "Hyperliquid API Secret 应为 Agent Wallet 的 0x 私钥");
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  if (account.address.toLowerCase() !== connection.apiKey.trim().toLowerCase()) throw new HttpError(400, "Hyperliquid Agent Wallet 地址与私钥不匹配");
  return account;
}

async function hyperMarket(connection: DecryptedConnection): Promise<[HyperMeta, HyperContext[]]> {
  const response = await fetch(`${baseUrl(connection)}/info`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }), signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new HttpError(502, `Hyperliquid 行情接口 HTTP ${response.status}`);
  return response.json<[HyperMeta, HyperContext[]]>();
}

async function signedHyperliquid(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  const wallet = hyperAccount(connection);
  const [meta, contexts] = await hyperMarket(connection);
  const symbol = normalizeSymbol(leg.symbol);
  const asset = meta.universe.findIndex((item) => !item.isDelisted && item.name.toUpperCase() === symbol);
  const definition = meta.universe[asset];
  const mark = Number(contexts[asset]?.markPx);
  if (asset < 0 || !definition || !Number.isFinite(mark) || mark <= 0) throw new HttpError(400, `Hyperliquid 不支持 ${symbol} 永续`);
  const { buy, reduceOnly } = orderSide(leg);
  const hash = await sha256(leg.clientOrderId);
  const action = {
    type: "order",
    orders: [{
      a: asset,
      b: buy,
      p: formatPrice(mark * (buy ? 1.01 : 0.99), definition.szDecimals),
      s: formatSize(positiveQuantity(leg.quantity), definition.szDecimals),
      r: reduceOnly,
      t: { limit: { tif: "Ioc" } },
      c: `0x${bytesToHex(hash).slice(0, 32)}`,
    }],
    grouping: "na",
  };
  const nonce = Date.now();
  const signature = await signL1Action({ wallet, action, nonce, isTestnet: connection.environment === "testnet" });
  return {
    requestId: crypto.randomUUID(), exchange: "Hyperliquid", method: "POST", url: `${baseUrl(connection)}/exchange`, headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, nonce, signature }),
  };
}

export async function signOrder(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  if (connection.exchange === "Binance") return signedBinance(connection, leg);
  if (connection.exchange === "Bybit") return signedBybit(connection, leg);
  if (connection.exchange === "OKX") return signedOkx(connection, leg);
  if (connection.exchange === "Bitget") return signedBitget(connection, leg);
  if (connection.exchange === "Hyperliquid") return signedHyperliquid(connection, leg);
  if (connection.exchange === "Gate.io") return signedGate(connection, leg);
  if (connection.exchange === "WEEX") return signedWeex(connection, leg);
  if (connection.exchange === "HTX") return signedHtx(connection, leg);
  return signedCoinbase(connection, leg);
}

export async function signVerification(connection: DecryptedConnection): Promise<SignedRelayRequest> {
  const timestampMs = String(Date.now());
  if (connection.exchange === "Binance") {
    const params = new URLSearchParams({ recvWindow: "5000", timestamp: timestampMs });
    params.set("signature", await hmac(connection.apiSecret, params.toString(), "hex"));
    return { requestId: crypto.randomUUID(), exchange: "Binance", method: "GET", url: `${baseUrl(connection)}/fapi/v3/account?${params}`, headers: { "X-MBX-APIKEY": connection.apiKey }, body: null };
  }
  if (connection.exchange === "Bybit") {
    const recvWindow = "5000";
    const query = "accountType=UNIFIED";
    return { requestId: crypto.randomUUID(), exchange: "Bybit", method: "GET", url: `${baseUrl(connection)}/v5/account/wallet-balance?${query}`, headers: { "X-BAPI-API-KEY": connection.apiKey, "X-BAPI-TIMESTAMP": timestampMs, "X-BAPI-RECV-WINDOW": recvWindow, "X-BAPI-SIGN": await hmac(connection.apiSecret, `${timestampMs}${connection.apiKey}${recvWindow}${query}`, "hex") }, body: null };
  }
  if (connection.exchange === "Gate.io") {
    const path = "/api/v4/futures/usdt/accounts";
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = await hmac(connection.apiSecret, `GET\n${path}\n\n${await sha512("")}\n${timestamp}`, "hex", "SHA-512");
    return { requestId: crypto.randomUUID(), exchange: "Gate.io", method: "GET", url: `${baseUrl(connection)}${path}`, headers: { KEY: connection.apiKey, Timestamp: timestamp, SIGN: signature }, body: null };
  }
  if (connection.exchange === "Hyperliquid") {
    const wallet = hyperAccount(connection);
    return { requestId: crypto.randomUUID(), exchange: "Hyperliquid", method: "POST", url: `${baseUrl(connection)}/info`, headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "userRole", user: wallet.address }) };
  }
  if (connection.exchange === "OKX") {
    if (!connection.passphrase) throw new HttpError(400, "OKX 连接缺少 Passphrase");
    const path = "/api/v5/account/balance";
    const timestamp = new Date().toISOString();
    return { requestId: crypto.randomUUID(), exchange: "OKX", method: "GET", url: `${baseUrl(connection)}${path}`, headers: { "OK-ACCESS-KEY": connection.apiKey, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": connection.passphrase, "OK-ACCESS-SIGN": await hmac(connection.apiSecret, `${timestamp}GET${path}`, "base64"), ...(connection.environment === "testnet" ? { "x-simulated-trading": "1" } : {}) }, body: null };
  }
  if (connection.exchange === "Bitget") {
    if (!connection.passphrase) throw new HttpError(400, "Bitget 连接缺少 Passphrase");
    const path = "/api/v2/mix/account/accounts";
    const query = "productType=USDT-FUTURES";
    return { requestId: crypto.randomUUID(), exchange: "Bitget", method: "GET", url: `${baseUrl(connection)}${path}?${query}`, headers: { "ACCESS-KEY": connection.apiKey, "ACCESS-TIMESTAMP": timestampMs, "ACCESS-PASSPHRASE": connection.passphrase, "ACCESS-SIGN": await hmac(connection.apiSecret, `${timestampMs}GET${path}?${query}`, "base64"), locale: "zh-CN", ...(connection.environment === "testnet" ? { paptrading: "1" } : {}) }, body: null };
  }
  if (connection.exchange === "WEEX") {
    if (!connection.passphrase) throw new HttpError(400, "WEEX 连接缺少 Passphrase");
    const path = connection.environment === "testnet" ? "/capi/v3/sim/balance" : "/capi/v3/account/balance";
    const timestamp = String(Date.now());
    return { requestId: crypto.randomUUID(), exchange: "WEEX", method: "GET", url: `${baseUrl(connection)}${path}`, body: null, headers: { "ACCESS-KEY": connection.apiKey, "ACCESS-SIGN": await hmac(connection.apiSecret, `${timestamp}GET${path}`, "base64"), "ACCESS-PASSPHRASE": connection.passphrase, "ACCESS-TIMESTAMP": timestamp } };
  }
  if (connection.exchange === "HTX") {
    if (connection.environment !== "live") throw new HttpError(400, "HTX 当前仅支持主网账户");
    return htxRequest(connection, "/linear-swap-api/v1/swap_account_info", "{}");
  }
  if (!connection.passphrase) throw new HttpError(400, "Coinbase 连接缺少 Passphrase");
  const path = "/api/v1/portfolios";
  const timestamp = String(Math.floor(Date.now() / 1_000));
  return { requestId: crypto.randomUUID(), exchange: "Coinbase", method: "GET", url: `${baseUrl(connection)}${path}`, body: null, headers: { "CB-ACCESS-KEY": connection.apiKey, "CB-ACCESS-PASSPHRASE": connection.passphrase, "CB-ACCESS-TIMESTAMP": timestamp, "CB-ACCESS-SIGN": await hmac(base64Bytes(connection.apiSecret), `${timestamp}GET${path}`, "base64") } };
}

function responseJson(body: string): Record<string, unknown> | unknown[] {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object") throw new Error();
    return value as Record<string, unknown> | unknown[];
  } catch {
    throw new Error("交易所返回了无法识别的响应");
  }
}

export function assertVerificationAccepted(exchange: TradingExchange, body: string): void {
  const payload = responseJson(body);
  if (exchange === "Hyperliquid") {
    const role = !Array.isArray(payload) ? payload.role : undefined;
    if (role !== "agent") throw new Error("Hyperliquid 地址不是已授权的 Agent Wallet；主钱包私钥禁止接入");
    return;
  }
  if (exchange === "Bybit" && !Array.isArray(payload) && payload.retCode !== 0) throw new Error(`Bybit 验权失败：${String(payload.retMsg ?? payload.retCode)}`);
  if (exchange === "OKX" && !Array.isArray(payload) && payload.code !== "0") throw new Error(`OKX 验权失败：${String(payload.msg ?? payload.code)}`);
  if (exchange === "Bitget" && !Array.isArray(payload) && payload.code !== "00000") throw new Error(`Bitget 验权失败：${String(payload.msg ?? payload.code)}`);
  if (exchange === "WEEX" && !Array.isArray(payload) && (payload.success === false || payload.code || payload.errorCode)) throw new Error(`WEEX 验权失败：${String(payload.errorMessage ?? payload.msg ?? payload.code ?? payload.errorCode)}`);
  if (exchange === "HTX" && !Array.isArray(payload) && payload.status !== "ok") throw new Error(`HTX 验权失败：${String(payload.err_msg ?? payload["err-code"] ?? payload.status)}`);
  if (exchange === "Coinbase" && !Array.isArray(payload)) throw new Error(`Coinbase 验权失败：${String(payload.message ?? payload.error ?? "未返回账户列表")}`);
  if (exchange === "Binance" && !Array.isArray(payload) && typeof payload.code === "number" && payload.code !== 0) throw new Error(`币安验权失败：${String(payload.msg ?? payload.code)}`);
}

export function assertOrderAccepted(exchange: TradingExchange, body: string): void {
  const payload = responseJson(body);
  if (exchange === "Bybit" && !Array.isArray(payload) && payload.retCode !== 0) throw new Error(String(payload.retMsg ?? "Bybit 拒绝委托"));
  if (exchange === "OKX" && !Array.isArray(payload)) {
    const data = Array.isArray(payload.data) ? payload.data[0] as Record<string, unknown> | undefined : undefined;
    if (payload.code !== "0" || data?.sCode !== "0") throw new Error(String(data?.sMsg ?? payload.msg ?? "OKX 拒绝委托"));
  }
  if (exchange === "Bitget" && !Array.isArray(payload) && payload.code !== "00000") throw new Error(String(payload.msg ?? "Bitget 拒绝委托"));
  if (exchange === "WEEX" && !Array.isArray(payload) && payload.success !== true) throw new Error(String(payload.errorMessage ?? "WEEX 拒绝委托"));
  if (exchange === "HTX" && !Array.isArray(payload) && payload.status !== "ok") throw new Error(String(payload.err_msg ?? payload["err-code"] ?? "HTX 拒绝委托"));
  if (exchange === "Hyperliquid" && !Array.isArray(payload)) {
    const response = payload.response as Record<string, unknown> | undefined;
    const data = response?.data as Record<string, unknown> | undefined;
    const statuses = Array.isArray(data?.statuses) ? data.statuses as Array<Record<string, unknown>> : [];
    const rejection = statuses.find((status) => typeof status.error === "string");
    if (payload.status !== "ok" || rejection) throw new Error(String(rejection?.error ?? "Hyperliquid 拒绝委托"));
  }
  if (exchange === "Binance" && !Array.isArray(payload) && typeof payload.code === "number" && payload.code !== 0) throw new Error(String(payload.msg ?? "币安拒绝委托"));
}
