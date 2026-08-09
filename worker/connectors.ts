import { HttpError } from "./http";

export const SUPPORTED_EXCHANGES = ["Binance", "Bybit", "OKX", "Bitget", "Gate.io", "KuCoin"] as const;
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

async function hmac(secret: string, value: string, format: "hex" | "base64", hash: "SHA-256" | "SHA-512" = "SHA-256"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return format === "hex" ? bytesToHex(signature) : bytesToBase64(signature);
}

async function sha512(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-512", textEncoder.encode(value)));
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

function kucoinSymbol(value: string): string {
  const base = normalizeSymbol(value);
  return `${base === "BTC" ? "XBT" : base}USDTM`;
}

function baseUrl(connection: DecryptedConnection): string {
  if (connection.exchange === "Binance") return connection.environment === "testnet" ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
  if (connection.exchange === "Bybit") return connection.environment === "testnet" ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
  if (connection.exchange === "OKX") return "https://www.okx.com";
  if (connection.exchange === "Bitget") return "https://api.bitget.com";
  if (connection.exchange === "Gate.io") return connection.environment === "testnet" ? "https://fx-api-testnet.gateio.ws" : "https://api.gateio.ws";
  return "https://api-futures.kucoin.com";
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

async function signedKuCoin(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  if (!connection.passphrase) throw new HttpError(400, "KuCoin 连接缺少 Passphrase");
  if (connection.environment !== "live") throw new HttpError(400, "KuCoin 当前仅支持主网账户");
  const { buy, reduceOnly } = orderSide(leg);
  const path = "/api/v1/orders";
  const timestamp = String(Date.now());
  const rawQuantity = positiveQuantity(leg.quantity);
  const size = Number(rawQuantity);
  if (!Number.isSafeInteger(size)) throw new HttpError(400, "KuCoin 委托数量必须填写正整数合约张数");
  const body = JSON.stringify({
    clientOid: leg.clientOrderId,
    side: buy ? "buy" : "sell",
    symbol: kucoinSymbol(leg.symbol),
    type: "market",
    size,
    reduceOnly,
    marginMode: "CROSS",
    leverage: "1",
  });
  const signature = await hmac(connection.apiSecret, `${timestamp}POST${path}${body}`, "base64");
  const passphrase = await hmac(connection.apiSecret, connection.passphrase, "base64");
  return {
    requestId: crypto.randomUUID(), exchange: "KuCoin", method: "POST", url: `${baseUrl(connection)}${path}`, body,
    headers: {
      "KC-API-KEY": connection.apiKey,
      "KC-API-SIGN": signature,
      "KC-API-TIMESTAMP": timestamp,
      "KC-API-PASSPHRASE": passphrase,
      "KC-API-KEY-VERSION": "2",
      "content-type": "application/json",
    },
  };
}

export async function signOrder(connection: DecryptedConnection, leg: OrderLeg): Promise<SignedRelayRequest> {
  if (connection.exchange === "Binance") return signedBinance(connection, leg);
  if (connection.exchange === "Bybit") return signedBybit(connection, leg);
  if (connection.exchange === "OKX") return signedOkx(connection, leg);
  if (connection.exchange === "Bitget") return signedBitget(connection, leg);
  if (connection.exchange === "Gate.io") return signedGate(connection, leg);
  return signedKuCoin(connection, leg);
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
  if (connection.exchange === "Gate.io") {
    const path = "/api/v4/futures/usdt/accounts";
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = await hmac(connection.apiSecret, `GET\n${path}\n\n${await sha512("")}\n${timestamp}`, "hex", "SHA-512");
    return { requestId: crypto.randomUUID(), exchange: "Gate.io", method: "GET", url: `${baseUrl(connection)}${path}`, headers: { KEY: connection.apiKey, Timestamp: timestamp, SIGN: signature }, body: null };
  }
  if (!connection.passphrase) throw new HttpError(400, `${connection.exchange} 连接缺少 Passphrase`);
  if (connection.exchange === "OKX") {
    const path = "/api/v5/account/balance";
    const timestamp = new Date().toISOString();
    return { requestId: crypto.randomUUID(), exchange: "OKX", method: "GET", url: `${baseUrl(connection)}${path}`, headers: { "OK-ACCESS-KEY": connection.apiKey, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": connection.passphrase, "OK-ACCESS-SIGN": await hmac(connection.apiSecret, `${timestamp}GET${path}`, "base64"), ...(connection.environment === "testnet" ? { "x-simulated-trading": "1" } : {}) }, body: null };
  }
  if (connection.exchange === "Bitget") {
    const path = "/api/v2/mix/account/accounts";
    const query = "productType=USDT-FUTURES";
    return { requestId: crypto.randomUUID(), exchange: "Bitget", method: "GET", url: `${baseUrl(connection)}${path}?${query}`, headers: { "ACCESS-KEY": connection.apiKey, "ACCESS-TIMESTAMP": timestampMs, "ACCESS-PASSPHRASE": connection.passphrase, "ACCESS-SIGN": await hmac(connection.apiSecret, `${timestampMs}GET${path}?${query}`, "base64"), locale: "zh-CN" }, body: null };
  }
  if (connection.environment !== "live") throw new HttpError(400, "KuCoin 当前仅支持主网账户");
  const path = "/api/v1/account-overview";
  const query = "currency=USDT";
  const timestamp = String(Date.now());
  const endpoint = `${path}?${query}`;
  return {
    requestId: crypto.randomUUID(), exchange: "KuCoin", method: "GET", url: `${baseUrl(connection)}${endpoint}`, body: null,
    headers: {
      "KC-API-KEY": connection.apiKey,
      "KC-API-SIGN": await hmac(connection.apiSecret, `${timestamp}GET${endpoint}`, "base64"),
      "KC-API-TIMESTAMP": timestamp,
      "KC-API-PASSPHRASE": await hmac(connection.apiSecret, connection.passphrase, "base64"),
      "KC-API-KEY-VERSION": "2",
    },
  };
}
