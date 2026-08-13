import { describe, expect, it } from "vitest";
import { hasExecutionPair } from "../worker/control-plane";

describe("execution readiness", () => {
  it("requires two different exchanges", () => {
    expect(hasExecutionPair([{ exchange: "Binance" }, { exchange: "Binance" }])).toBe(false);
    expect(hasExecutionPair([{ exchange: "Binance" }, { exchange: "OKX" }])).toBe(true);
  });
});
