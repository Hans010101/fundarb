import { afterEach, describe, expect, it, vi } from "vitest";
import { signOrder, signVerification, type DecryptedConnection, type OrderLeg } from "../worker/connectors";

const leg: OrderLeg = {
  symbol: "BTC",
  direction: "long",
  action: "open",
  quantity: "3",
  clientOrderId: "fundarb-test-order-001",
};

function connection(exchange: DecryptedConnection["exchange"], passphrase: string | null = null): DecryptedConnection {
  return { id: "test", exchange, environment: "live", apiKey: "test-api-key", apiSecret: "test-api-secret", passphrase };
}

describe("additional execution connectors", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("signs Gate.io market orders and account verification without a passphrase", async () => {
    const order = await signOrder(connection("Gate.io"), leg);
    const body = JSON.parse(order.body ?? "{}") as { contract: string; size: string; price: string; tif: string; reduce_only: boolean };
    expect(order.url).toBe("https://api.gateio.ws/api/v4/futures/usdt/orders");
    expect(body).toMatchObject({ contract: "BTC_USDT", size: "3", price: "0", tif: "ioc", reduce_only: false });
    expect(order.headers.SIGN).toMatch(/^[a-f0-9]{128}$/);
    const verification = await signVerification(connection("Gate.io"));
    expect(verification.url).toBe("https://api.gateio.ws/api/v4/futures/usdt/accounts");
  });

  it("signs WEEX V3 market orders", async () => {
    const order = await signOrder(connection("WEEX", "test-passphrase"), leg);
    const body = JSON.parse(order.body ?? "{}") as { symbol: string; side: string; positionSide: string; type: string };
    expect(order.url).toBe("https://api-contract.weex.com/capi/v3/order");
    expect(body).toMatchObject({ symbol: "BTCUSDT", side: "BUY", positionSide: "LONG", type: "MARKET" });
    expect(order.headers["ACCESS-PASSPHRASE"]).toBe("test-passphrase");
    expect(order.headers["ACCESS-SIGN"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("signs HTX isolated one-times leverage orders", async () => {
    const order = await signOrder(connection("HTX"), leg);
    const body = JSON.parse(order.body ?? "{}") as { contract_code: string; volume: number; lever_rate: number; order_price_type: string };
    expect(order.url).toContain("https://api.hbdm.com/linear-swap-api/v1/swap_order?");
    expect(body).toMatchObject({ contract_code: "BTC-USDT", volume: 3, lever_rate: 1, order_price_type: "optimal_5" });
    expect(order.url).toContain("Signature=");
  });

  it("signs Coinbase International market orders with a decoded secret", async () => {
    const account = { ...connection("Coinbase", "test-passphrase"), apiSecret: "dGVzdC1jb2luYmFzZS1zZWNyZXQ=" };
    const order = await signOrder(account, leg);
    const body = JSON.parse(order.body ?? "{}") as { instrument: string; type: string; close_only: boolean };
    expect(order.url).toBe("https://api.international.coinbase.com/api/v1/orders");
    expect(body).toMatchObject({ instrument: "BTC-PERP", type: "MARKET", close_only: false });
    expect(order.headers["CB-ACCESS-SIGN"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("validates Hyperliquid Agent Wallet credentials before relay verification", async () => {
    const account: DecryptedConnection = {
      ...connection("Hyperliquid"),
      apiKey: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
      apiSecret: `0x${"0".repeat(63)}1`,
    };
    const verification = await signVerification(account);
    expect(verification.url).toBe("https://api.hyperliquid.xyz/info");
    expect(JSON.parse(verification.body ?? "{}")).toMatchObject({ type: "userRole", user: account.apiKey });
  });

  it("builds and signs a Hyperliquid IOC order from live metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { universe: [{ name: "BTC", szDecimals: 5 }] },
      [{ markPx: "100000" }],
    ]), { status: 200, headers: { "content-type": "application/json" } })));
    const account: DecryptedConnection = {
      ...connection("Hyperliquid"),
      apiKey: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
      apiSecret: `0x${"0".repeat(63)}1`,
    };
    const order = await signOrder(account, { ...leg, quantity: "0.00123" });
    const body = JSON.parse(order.body ?? "{}") as { action: { orders: Array<{ a: number; b: boolean; s: string; r: boolean; t: { limit: { tif: string } } }> }; signature: { r: string; s: string; v: number } };
    expect(order.url).toBe("https://api.hyperliquid.xyz/exchange");
    expect(body.action.orders[0]).toMatchObject({ a: 0, b: true, s: "0.00123", r: false, t: { limit: { tif: "Ioc" } } });
    expect(body.signature.r).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
