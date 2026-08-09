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
