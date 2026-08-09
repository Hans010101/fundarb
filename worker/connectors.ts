import { HttpError } from "./http";

export const SUPPORTED_EXCHANGES = ["Binance", "Bybit", "OKX", "Bitget"] as const;
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

async function hmac(secret: string, value: string, format: "hex" | "base64"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return format === "hex" ? bytesToHex(signature) : bytesToBase64(signature);
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

function baseUrl(connection: DecryptedConnection): string {
  if (connection.exchange === "Binance") return connection.environment === "testnet" ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
  if (connection.exchange === "Bybit") return connection.environment === "testnet" ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
  if (connection.exchange === "OKX") return "https://www.okx.com";
  return "https://api.bitget.com";
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
    },
  };
}

export async function signOrder(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  if (connection.exchange === "Binance") return signedBinance(connection, leg);
  if (connection.exchange === "Bybit") return signedBybit(connection, leg);
  if (connection.exchange === "OKX") return signedOkx(connection, leg);
  return signedBitget(connection, leg);
}

export async function signVerification(connection: DecryptedConnection): Promise<SignedRelayRequest> {
  const timestampMs = String(Date.now());
  if (connection.exchange === "Binance") {
    const params = new URLSearchParams({ recvWindow: "5000", timestamp: timestampMs });
    params.set("signature", await hmac(connection.apiSecret, params.toString(), "hex"));
    return { requestId: crypto.randomUUID(), exchange: "Binance", method: "GET", url: `${baseUrl(connection)}/fapi/v2/account?${params}`, headers: { "X-MBX-APIKEY": connection.apiKey }, body: null };
  }
  if (connection.exchange === "Bybit") {
    const recvWindow = "5000";
    const query = "accountType=UNIFIED";
    return { requestId: crypto.randomUUID(), exchange: "Bybit", method: "GET", url: `${baseUrl(connection)}/v5/account/wallet-balance?${query}`, headers: { "X-BAPI-API-KEY": connection.apiKey, "X-BAPI-TIMESTAMP": timestampMs, "X-BAPI-RECV-WINDOW": recvWindow, "X-BAPI-SIGN": await hmac(connection.apiSecret, `${timestampMs}${connection.apiKey}${recvWindow}${query}`, "hex") }, body: null };
  }
  if (!connection.passphrase) throw new HttpError(400, `${connection.exchange} 连接缺少 Passphrase`);
  if (connection.exchange === "OKX") {
    const path = "/api/v5/account/balance";
    const timestamp = new Date().toISOString();
    return { requestId: crypto.randomUUID(), exchange: "OKX", method: "GET", url: `${baseUrl(connection)}${path}`, headers: { "OK-ACCESS-KEY": connection.apiKey, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": connection.passphrase, "OK-ACCESS-SIGN": await hmac(connection.apiSecret, `${timestamp}GET${path}`, "base64"), ...(connection.environment === "testnet" ? { "x-simulated-trading": "1" } : {}) }, body: null };
  }
  const path = "/api/v2/mix/account/accounts";
  const query = "productType=USDT-FUTURES";
  return { requestId: crypto.randomUUID(), exchange: "Bitget", method: "GET", url: `${baseUrl(connection)}${path}?${query}`, headers: { "ACCESS-KEY": connection.apiKey, "ACCESS-TIMESTAMP": timestampMs, "ACCESS-PASSPHRASE": connection.passphrase, "ACCESS-SIGN": await hmac(connection.apiSecret, `${timestampMs}GET${path}?${query}`, "base64"), locale: "zh-CN" }, body: null };
}
