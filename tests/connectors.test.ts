import { describe, expect, it } from "vitest";
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
  it("signs Gate.io market orders and account verification without a passphrase", async () => {
    const order = await signOrder(connection("Gate.io"), leg);
    const body = JSON.parse(order.body ?? "{}") as { contract: string; size: string; price: string; tif: string; reduce_only: boolean };
    expect(order.url).toBe("https://api.gateio.ws/api/v4/futures/usdt/orders");
    expect(body).toMatchObject({ contract: "BTC_USDT", size: "3", price: "0", tif: "ioc", reduce_only: false });
    expect(order.headers.SIGN).toMatch(/^[a-f0-9]{128}$/);
    const verification = await signVerification(connection("Gate.io"));
    expect(verification.url).toBe("https://api.gateio.ws/api/v4/futures/usdt/accounts");
  });

  it("signs KuCoin market orders with version-2 passphrase protection", async () => {
    const order = await signOrder(connection("KuCoin", "test-passphrase"), leg);
    const body = JSON.parse(order.body ?? "{}") as { symbol: string; size: number; type: string };
    expect(order.url).toBe("https://api-futures.kucoin.com/api/v1/orders");
    expect(body).toMatchObject({ symbol: "XBTUSDTM", size: 3, type: "market" });
    expect(order.headers["KC-API-KEY-VERSION"]).toBe("2");
    expect(order.headers["KC-API-PASSPHRASE"]).not.toBe("test-passphrase");
  });
});
