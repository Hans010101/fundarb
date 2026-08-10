import assert from "node:assert/strict";
import test from "node:test";
import { validateForwardRequest } from "./server.mjs";

const valid = {
  requestId: "11111111-1111-4111-8111-111111111111",
  exchange: "Bybit",
  method: "POST",
  url: "https://api-testnet.bybit.com/v5/order/create",
  headers: { "X-BAPI-API-KEY": "key", "content-type": "application/json" },
  body: "{}",
};

test("accepts an allowlisted exchange endpoint", () => {
  assert.equal(validateForwardRequest(valid).target.hostname, "api-testnet.bybit.com");
});

test("rejects arbitrary proxy targets", () => {
  assert.throws(() => validateForwardRequest({ ...valid, url: "https://example.com/steal" }), /白名单/);
});

test("rejects unapproved headers", () => {
  assert.throws(() => validateForwardRequest({ ...valid, headers: { authorization: "secret" } }), /请求头/);
});

test("accepts Gate.io and the newly selected exchange endpoints", () => {
  const gate = validateForwardRequest({ ...valid, exchange: "Gate.io", url: "https://api.gateio.ws/api/v4/futures/usdt/orders", headers: { KEY: "key", Timestamp: "1", SIGN: "signature" } });
  const weex = validateForwardRequest({ ...valid, exchange: "WEEX", url: "https://api-contract.weex.com/capi/v3/order", headers: { "ACCESS-KEY": "key", "ACCESS-SIGN": "signature" } });
  const hyperliquid = validateForwardRequest({ ...valid, exchange: "Hyperliquid", url: "https://api.hyperliquid.xyz/exchange" });
  const coinbase = validateForwardRequest({ ...valid, exchange: "Coinbase", method: "GET", url: "https://api.international.coinbase.com/api/v1/portfolios", body: null, headers: { "CB-ACCESS-KEY": "key", "CB-ACCESS-SIGN": "signature" } });
  assert.equal(gate.target.hostname, "api.gateio.ws");
  assert.equal(weex.target.hostname, "api-contract.weex.com");
  assert.equal(hyperliquid.target.pathname, "/exchange");
  assert.equal(coinbase.target.hostname, "api.international.coinbase.com");
});

test("accepts only explicitly allowlisted public market-data paths", () => {
  const market = validateForwardRequest({ ...valid, exchange: "Binance", method: "GET", url: "https://fapi.binance.com/fapi/v1/premiumIndex", headers: { accept: "application/json" }, body: null });
  assert.equal(market.target.pathname, "/fapi/v1/premiumIndex");
  assert.throws(() => validateForwardRequest({ ...valid, method: "GET", url: "https://fapi.binance.com/fapi/v1/openInterest", body: null }), /白名单/);
});
