import type { ControlPlaneStatus, ExecutionMode } from "../src/lib/admin-types";
import { SUPPORTED_EXCHANGES, type DecryptedConnection, type TradingEnvironment, type TradingExchange, signVerification } from "./connectors";
import { HttpError, json, readJson, requireAdmin } from "./http";
import { credentialFingerprint, decryptCredential, encryptCredential } from "./vault";

interface ConnectionRow {
  id: string;
  exchange: TradingExchange;
  environment: TradingEnvironment;
  label: string;
  api_key_ciphertext: string;
  api_secret_ciphertext: string;
  passphrase_ciphertext: string | null;
  fingerprint: string;
  enabled: number;
  verification_status: string;
  last_verified_at: number | null;
  last_error: string | null;
  created_at: number;
}

interface HedgeRow {
  id: string; mode: ExecutionMode; symbol: string; long_connection_id: string; short_connection_id: string;
  long_quantity: string; short_quantity: string; notional_usd: string; hard_leg: "long" | "short";
  state: string; error: string | null; created_at: number; updated_at: number;
}

interface SaveConnectionBody {
  id?: string;
  exchange: string;
  environment: string;
  label: string;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
}

interface UpdateConnectionBody { enabled: boolean }
interface SettingsBody {
  mode?: ExecutionMode;
  executionEmergencyStop?: boolean;
  orderSubmissionEnabled?: boolean;
  liveEnabled?: boolean;
  maxOrderNotionalUsd?: number;
  maxEffectiveLeverage?: number;
  confirmation?: string;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  return value === undefined ? fallback : value === "true";
}

export async function settingsMap(db: D1Database): Promise<Map<string, string>> {
  const rows = await db.prepare("SELECT key, value FROM platform_settings").all<{ key: string; value: string }>();
  return new Map((rows.results ?? []).map((row) => [row.key, row.value]));
}

export async function connectionById(env: Env, id: string): Promise<DecryptedConnection> {
  const row = await env.DB.prepare("SELECT * FROM exchange_connections WHERE id = ?").bind(id).first<ConnectionRow>();
  if (!row) throw new HttpError(404, "交易所连接不存在");
  return {
    id: row.id, exchange: row.exchange, environment: row.environment,
    apiKey: await decryptCredential(row.api_key_ciphertext, env.CREDENTIAL_MASTER_KEY),
    apiSecret: await decryptCredential(row.api_secret_ciphertext, env.CREDENTIAL_MASTER_KEY),
    passphrase: row.passphrase_ciphertext ? await decryptCredential(row.passphrase_ciphertext, env.CREDENTIAL_MASTER_KEY) : null,
  };
}

export async function relay(env: Env, payload: unknown): Promise<{ ok: boolean; status: number; body: string }> {
  const relayUrl = env.EXECUTION_RELAY_URL as string;
  if (!relayUrl) throw new HttpError(409, "尚未配置固定 IP 执行中继");
  const response = await fetch(`${relayUrl.replace(/\/$/, "")}/v1/forward`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.EXECUTION_RELAY_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body: body.slice(0, 16_384) };
}

async function audit(env: Env, eventType: string, severity: string, payload: unknown): Promise<void> {
  await env.DB.prepare("INSERT INTO audit_log (id, event_type, severity, actor, payload, created_at) VALUES (?, ?, ?, 'operator', ?, ?)")
    .bind(crypto.randomUUID(), eventType, severity, JSON.stringify(payload), Date.now()).run();
}

async function status(env: Env): Promise<Response> {
  const [settings, connections, hedges] = await Promise.all([
    settingsMap(env.DB),
    env.DB.prepare("SELECT * FROM exchange_connections ORDER BY created_at DESC").all<ConnectionRow>(),
    env.DB.prepare("SELECT * FROM hedge_intents ORDER BY created_at DESC LIMIT 50").all<HedgeRow>(),
  ]);
  const body: ControlPlaneStatus = {
    authenticated: true,
    relayConfigured: Boolean(env.EXECUTION_RELAY_URL),
    settings: {
      mode: (settings.get("mode") ?? "paper") as ExecutionMode,
      executionEmergencyStop: bool(settings.get("execution_emergency_stop"), true),
      orderSubmissionEnabled: bool(settings.get("order_submission_enabled"), false),
      liveEnabled: bool(settings.get("live_enabled"), false),
      maxOrderNotionalUsd: Number(settings.get("max_order_notional_usd") ?? "2000"),
      maxEffectiveLeverage: Number(settings.get("max_effective_leverage") ?? "2"),
    },
    connections: (connections.results ?? []).map((row) => ({
      id: row.id, exchange: row.exchange, environment: row.environment, label: row.label, fingerprint: row.fingerprint,
      enabled: row.enabled === 1, verificationStatus: row.verification_status, lastVerifiedAt: row.last_verified_at,
      lastError: row.last_error, createdAt: row.created_at,
    })),
    hedges: (hedges.results ?? []).map((row) => ({
      id: row.id, mode: row.mode, symbol: row.symbol, longConnectionId: row.long_connection_id,
      shortConnectionId: row.short_connection_id, longQuantity: row.long_quantity, shortQuantity: row.short_quantity,
      notionalUsd: row.notional_usd, hardLeg: row.hard_leg, state: row.state, error: row.error,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })),
  };
  return json(body);
}

async function saveConnection(request: Request, env: Env): Promise<Response> {
  const body = await readJson<SaveConnectionBody>(request);
  if (!SUPPORTED_EXCHANGES.includes(body.exchange as TradingExchange)) throw new HttpError(400, "暂不支持该交易所的真实委托");
  if (body.environment !== "testnet" && body.environment !== "live") throw new HttpError(400, "账户环境无效");
  if (!body.label?.trim() || body.label.trim().length > 40) throw new HttpError(400, "连接名称应为 1–40 个字符");
  if (body.apiKey?.length < 8 || body.apiSecret?.length < 8) throw new HttpError(400, "API Key 或 Secret 格式无效");
  if ((body.exchange === "OKX" || body.exchange === "Bitget") && !body.passphrase) throw new HttpError(400, `${body.exchange} 需要 Passphrase`);
  const id = body.id ?? crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO exchange_connections
    (id, exchange, environment, label, api_key_ciphertext, api_secret_ciphertext, passphrase_ciphertext, fingerprint, enabled, verification_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'unverified', ?, ?)
    ON CONFLICT(id) DO UPDATE SET exchange=excluded.exchange, environment=excluded.environment, label=excluded.label,
      api_key_ciphertext=excluded.api_key_ciphertext, api_secret_ciphertext=excluded.api_secret_ciphertext,
      passphrase_ciphertext=excluded.passphrase_ciphertext, fingerprint=excluded.fingerprint,
      enabled=0, verification_status='unverified', last_error=NULL, updated_at=excluded.updated_at`)
    .bind(id, body.exchange, body.environment, body.label.trim(),
      await encryptCredential(body.apiKey, env.CREDENTIAL_MASTER_KEY),
      await encryptCredential(body.apiSecret, env.CREDENTIAL_MASTER_KEY),
      body.passphrase ? await encryptCredential(body.passphrase, env.CREDENTIAL_MASTER_KEY) : null,
      await credentialFingerprint(body.apiKey), now, now).run();
  await audit(env, "connection_saved", "INFO", { id, exchange: body.exchange, environment: body.environment });
  return json({ ok: true, id, message: "连接已加密保存，启用前请先验权" }, 201);
}

async function updateConnection(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readJson<UpdateConnectionBody>(request);
  const row = await env.DB.prepare("SELECT verification_status FROM exchange_connections WHERE id=?").bind(id).first<{ verification_status: string }>();
  if (!row) throw new HttpError(404, "交易所连接不存在");
  if (body.enabled && row.verification_status !== "verified") throw new HttpError(409, "连接通过验权后才能启用");
  await env.DB.prepare("UPDATE exchange_connections SET enabled=?, updated_at=? WHERE id=?").bind(body.enabled ? 1 : 0, Date.now(), id).run();
  await audit(env, "connection_toggled", "WARN", { id, enabled: body.enabled });
  return json({ ok: true });
}

async function verifyConnection(env: Env, id: string): Promise<Response> {
  const connection = await connectionById(env, id);
  try {
    const result = await relay(env, await signVerification(connection));
    if (!result.ok) throw new Error(`中继返回 HTTP ${result.status}: ${result.body.slice(0, 300)}`);
    await env.DB.prepare("UPDATE exchange_connections SET verification_status='verified', last_verified_at=?, last_error=NULL, updated_at=? WHERE id=?")
      .bind(Date.now(), Date.now(), id).run();
    await audit(env, "connection_verified", "INFO", { id, exchange: connection.exchange });
    return json({ ok: true, message: "账户验权通过" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "账户验权失败";
    await env.DB.prepare("UPDATE exchange_connections SET verification_status='failed', last_error=?, updated_at=? WHERE id=?")
      .bind(message.slice(0, 500), Date.now(), id).run();
    await audit(env, "connection_verification_failed", "DANGER", { id, error: message.slice(0, 200) });
    throw error;
  }
}

async function updateSettings(request: Request, env: Env): Promise<Response> {
  const body = await readJson<SettingsBody>(request);
  const safetyReduced = body.executionEmergencyStop === false || body.orderSubmissionEnabled === true || body.liveEnabled === true || body.mode === "live";
  if (safetyReduced && body.confirmation !== "我确认调整交易总闸") throw new HttpError(400, "调整交易总闸需要输入确认语句");
  if (body.mode && !["paper", "testnet", "live"].includes(body.mode)) throw new HttpError(400, "运行模式无效");
  if (body.maxOrderNotionalUsd !== undefined && (!Number.isFinite(body.maxOrderNotionalUsd) || body.maxOrderNotionalUsd < 10 || body.maxOrderNotionalUsd > 10_000)) throw new HttpError(400, "单组名义应在 10–10,000 USDT");
  if (body.maxEffectiveLeverage !== undefined && (!Number.isFinite(body.maxEffectiveLeverage) || body.maxEffectiveLeverage < 1 || body.maxEffectiveLeverage > 3)) throw new HttpError(400, "有效杠杆硬上限为 3 倍");
  const entries: Array<[string, string]> = [];
  if (body.mode) entries.push(["mode", body.mode]);
  if (body.executionEmergencyStop !== undefined) entries.push(["execution_emergency_stop", String(body.executionEmergencyStop)]);
  if (body.orderSubmissionEnabled !== undefined) entries.push(["order_submission_enabled", String(body.orderSubmissionEnabled)]);
  if (body.liveEnabled !== undefined) entries.push(["live_enabled", String(body.liveEnabled)]);
  if (body.maxOrderNotionalUsd !== undefined) entries.push(["max_order_notional_usd", String(body.maxOrderNotionalUsd)]);
  if (body.maxEffectiveLeverage !== undefined) entries.push(["max_effective_leverage", String(body.maxEffectiveLeverage)]);
  if (entries.length === 0) throw new HttpError(400, "没有需要更新的设置");
  const now = Date.now();
  await env.DB.batch(entries.map(([key, value]) => env.DB.prepare("INSERT INTO platform_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(key, value, now)));
  await audit(env, "settings_updated", safetyReduced ? "CRITICAL" : "WARN", Object.fromEntries(entries));
  return json({ ok: true });
}

export async function handleControlPlane(request: Request, env: Env, pathname: string): Promise<Response> {
  requireAdmin(request, env);
  if (request.method === "GET" && pathname === "/api/admin/status") return status(env);
  if (request.method === "POST" && pathname === "/api/admin/connections") return saveConnection(request, env);
  if (request.method === "PATCH" && /^\/api\/admin\/connections\/[^/]+$/.test(pathname)) return updateConnection(request, env, pathname.split("/").at(-1)!);
  if (request.method === "POST" && /^\/api\/admin\/connections\/[^/]+\/verify$/.test(pathname)) return verifyConnection(env, pathname.split("/").at(-2)!);
  if (request.method === "PATCH" && pathname === "/api/admin/settings") return updateSettings(request, env);
  throw new HttpError(404, "管理接口不存在");
}
