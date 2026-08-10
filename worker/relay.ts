export interface RelayTransport {
  relayUrl?: string;
  relayToken?: string;
  source: "direct" | "static" | "dynamic" | "expired" | "misconfigured";
  egressIpv4: string | null;
  expiresAt: number | null;
}

interface RelaySettingRow {
  key: string;
  value: string;
}

const SETTING_KEYS = [
  "execution_relay_mode",
  "execution_relay_url",
  "execution_relay_egress_ipv4",
  "execution_relay_expires_at",
] as const;

export function validateRelayUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (!/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function resolveRelayTransport(env: Pick<Env, "DB" | "EXECUTION_RELAY_URL" | "EXECUTION_RELAY_TOKEN">): Promise<RelayTransport> {
  const result = await env.DB.prepare(`
    SELECT key,value FROM platform_settings
    WHERE key IN (${SETTING_KEYS.map(() => "?").join(",")})
  `).bind(...SETTING_KEYS).all<RelaySettingRow>();
  const settings = new Map((result.results ?? []).map((row) => [row.key, row.value]));
  if (settings.get("execution_relay_mode") === "dynamic-mac-pilot") {
    const relayUrl = validateRelayUrl(settings.get("execution_relay_url"));
    const expiresAt = Number(settings.get("execution_relay_expires_at"));
    const active = Boolean(relayUrl) && Number.isFinite(expiresAt) && expiresAt > Date.now();
    return {
      relayUrl: active ? relayUrl! : undefined,
      relayToken: active ? env.EXECUTION_RELAY_TOKEN : undefined,
      source: active ? "dynamic" : "expired",
      egressIpv4: settings.get("execution_relay_egress_ipv4") || null,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    };
  }

  const relayUrl = String(env.EXECUTION_RELAY_URL ?? "").trim().replace(/\/$/, "");
  const relayToken = String(env.EXECUTION_RELAY_TOKEN ?? "");
  if (!relayUrl && !relayToken) return { source: "direct", egressIpv4: null, expiresAt: null };
  if (!relayUrl || relayToken.length < 32) {
    return { relayUrl: relayUrl || undefined, source: "misconfigured", egressIpv4: null, expiresAt: null };
  }
  return { relayUrl, relayToken, source: "static", egressIpv4: null, expiresAt: null };
}

export function relayAvailable(transport: RelayTransport): boolean {
  return Boolean(transport.relayUrl && transport.relayToken);
}
