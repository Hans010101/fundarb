import { validateRelayUrl } from "./relay";

interface RegistryEnv {
  DB: D1Database;
  EXECUTION_RELAY_TOKEN: string;
}

const MAX_BODY_BYTES = 2_048;
const REGISTRATION_TTL_MS = 5 * 60_000;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function secureEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function validIpv4(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part);
}

export function validateRegistration(value: unknown): { url: string; egressIpv4: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const url = validateRelayUrl(body.url);
  return url && validIpv4(body.egress_ipv4) ? { url, egressIpv4: body.egress_ipv4 } : null;
}

async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok || Number(response.headers.get("content-length") ?? "0") > 4_096) {
      await response.body?.cancel();
      return false;
    }
    const health = await response.json<Record<string, unknown>>();
    return health.ok === true && health.service === "fundarb-execution-relay";
  } catch {
    return false;
  }
}

async function setSettings(env: RegistryEnv, values: Record<string, string>): Promise<void> {
  const now = Date.now();
  await env.DB.batch(Object.entries(values).map(([key, value]) => env.DB.prepare(`
    INSERT INTO platform_settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
  `).bind(key, value, now)));
}

export default {
  async fetch(request: Request, env: RegistryEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true, service: "fundarb-relay-registry" });
    if (url.pathname !== "/register") return json({ error: "Not found" }, 404);
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (env.EXECUTION_RELAY_TOKEN.length < 32 || !secureEqual(bearer, env.EXECUTION_RELAY_TOKEN)) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (request.method === "DELETE") {
      await setSettings(env, {
        execution_relay_mode: "dynamic-mac-pilot",
        execution_relay_url: "",
        execution_relay_egress_ipv4: "",
        execution_relay_expires_at: "0",
      });
      return json({ ok: true, status: "disabled" });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY_BYTES) return json({ error: "Body too large" }, 413);
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const registration = validateRegistration(parsed);
    if (!registration) return json({ error: "Invalid registration" }, 422);
    const observedIp = request.headers.get("cf-connecting-ip");
    if (observedIp && observedIp !== registration.egressIpv4) return json({ error: "Egress IP mismatch" }, 403);
    if (!await probe(registration.url)) return json({ error: "Relay health probe failed" }, 422);
    const expiresAt = Date.now() + REGISTRATION_TTL_MS;
    await setSettings(env, {
      execution_relay_mode: "dynamic-mac-pilot",
      execution_relay_url: registration.url,
      execution_relay_egress_ipv4: registration.egressIpv4,
      execution_relay_expires_at: String(expiresAt),
    });
    return json({ ok: true, status: "registered", expiresAt });
  },
} satisfies ExportedHandler<RegistryEnv>;
