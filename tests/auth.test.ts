import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateAdmin } from "../worker/http";

const env = {
  TEAM_DOMAIN: "https://fundarb-test.cloudflareaccess.com",
  POLICY_AUD: "fundarb-audience",
  AUTHORIZED_EMAIL: "hans.pan007@gmail.com",
  ADMIN_API_TOKEN: "recovery-token",
};

afterEach(() => vi.restoreAllMocks());

async function accessToken(email: string): Promise<string> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = crypto.randomUUID();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [jwk] })));
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setIssuer(env.TEAM_DOMAIN)
    .setAudience(env.POLICY_AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("admin authentication", () => {
  it("accepts a valid Cloudflare Access JWT for the bound Gmail", async () => {
    const token = await accessToken(env.AUTHORIZED_EMAIL);
    const identity = await authenticateAdmin(new Request("https://fundarb.test", { headers: { "cf-access-jwt-assertion": token } }), env);
    expect(identity).toEqual({ email: env.AUTHORIZED_EMAIL, method: "cloudflare-access" });
  });

  it("rejects a valid JWT for every other email", async () => {
    const token = await accessToken("other@gmail.com");
    const identity = await authenticateAdmin(new Request("https://fundarb.test", { headers: { "cf-access-jwt-assertion": token } }), env);
    expect(identity).toBeNull();
  });

  it("keeps the recovery token for non-browser emergencies", async () => {
    const identity = await authenticateAdmin(new Request("https://fundarb.test", { headers: { authorization: `Bearer ${env.ADMIN_API_TOKEN}` } }), env);
    expect(identity).toEqual({ email: "recovery@local", method: "recovery-token" });
  });
});
