import { describe, expect, it } from "vitest";
import { validateRegistration } from "../worker/relay-registry";
import { validateRelayUrl } from "../worker/relay";

describe("dynamic execution relay", () => {
  it("accepts only root trycloudflare URLs", () => {
    expect(validateRelayUrl("https://fundarb-demo.trycloudflare.com")).toBe("https://fundarb-demo.trycloudflare.com");
    expect(validateRelayUrl("https://fundarb-demo.trycloudflare.com/steal")).toBeNull();
    expect(validateRelayUrl("https://example.com")).toBeNull();
  });

  it("validates registration egress IPv4", () => {
    expect(validateRegistration({ url: "https://fundarb-demo.trycloudflare.com", egress_ipv4: "203.0.113.8" }))
      .toEqual({ url: "https://fundarb-demo.trycloudflare.com", egressIpv4: "203.0.113.8" });
    expect(validateRegistration({ url: "https://fundarb-demo.trycloudflare.com", egress_ipv4: "999.0.0.1" })).toBeNull();
  });
});
