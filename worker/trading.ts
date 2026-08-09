import type { ExecutionMode } from "../src/lib/admin-types";
import { signOrder, type DecryptedConnection, type OrderLeg, type TradingEnvironment } from "./connectors";
import { connectionById, relay, settingsMap } from "./control-plane";
import { HttpError, json, readJson, requireAdmin } from "./http";

const ABSOLUTE_MAX_ORDER_NOTIONAL_USD = 10_000;

interface OpenHedgeBody {
  idempotencyKey: string;
  symbol: string;
  longConnectionId: string;
  shortConnectionId: string;
  longQuantity: string;
  shortQuantity: string;
  notionalUsd: number;
  hardLeg: "long" | "short";
  confirmation: string;
  liveConfirmation?: string;
}

interface HedgeRow {
  id: string; mode: ExecutionMode; symbol: string; long_connection_id: string; short_connection_id: string;
  long_quantity: string; short_quantity: string; notional_usd: string; hard_leg: "long" | "short"; state: string;
}

interface RelayExchangeResponse { orderId?: string; result?: { orderId?: string }; data?: Array<{ ordId?: string }> | { orderId?: string } }

function validQuantity(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value) && Number(value) > 0;
}

function normalizedSymbol(value: string): string {
  const symbol = value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/USDT$/, "");
  if (!/^[A-Z0-9]{2,18}$/.test(symbol)) throw new HttpError(400, "交易对格式无效");
  return symbol;
}

function clientOrderId(hedgeId: string, leg: "long" | "short", action: "open" | "close" | "rollback", sequence: number): string {
  return `fa-${hedgeId.slice(0, 8)}-${leg[0]}-${action[0]}-${String(sequence).padStart(2, "0")}`;
}

function exchangeOrderId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as RelayExchangeResponse;
    if (typeof parsed.orderId === "string") return parsed.orderId;
    if (typeof parsed.result?.orderId === "string") return parsed.result.orderId;
    if (Array.isArray(parsed.data) && typeof parsed.data[0]?.ordId === "string") return parsed.data[0].ordId;
    if (!Array.isArray(parsed.data) && typeof parsed.data?.orderId === "string") return parsed.data.orderId;
  } catch {
    return null;
  }
  return null;
}

async function writeAudit(env: Env, eventType: string, severity: string, payload: unknown): Promise<void> {
  await env.DB.prepare("INSERT INTO audit_log (id,event_type,severity,actor,payload,created_at) VALUES (?,?,?,'operator',?,?)")
    .bind(crypto.randomUUID(), eventType, severity, JSON.stringify(payload), Date.now()).run();
}

async function persistOrder(env: Env, hedgeId: string, connectionId: string, leg: "long" | "short", action: "open" | "close" | "rollback", side: string, quantity: string, id: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO orders
    (client_order_id, hedge_intent_id, connection_id, leg, action, side, quantity, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_SEND', ?, ?)`)
    .bind(id, hedgeId, connectionId, leg, action, side, quantity, Date.now(), Date.now()).run();
}

async function submitLeg(env: Env, hedgeId: string, connection: DecryptedConnection, legName: "long" | "short", leg: OrderLeg): Promise<{ ok: boolean; clientOrderId: string; error?: string }> {
  const side = leg.direction === "long" ? (leg.action === "open" ? "BUY" : "SELL") : (leg.action === "open" ? "SELL" : "BUY");
  await persistOrder(env, hedgeId, connection.id, legName, leg.action, side, leg.quantity, leg.clientOrderId);
  try {
    const signed = await signOrder(connection, leg);
    const response = await relay(env, signed);
    if (!response.ok) {
      await env.DB.prepare("UPDATE orders SET status='REJECTED', error=?, raw_response=?, updated_at=? WHERE client_order_id=?")
        .bind(`HTTP ${response.status}`, response.body, Date.now(), leg.clientOrderId).run();
      return { ok: false, clientOrderId: leg.clientOrderId, error: `交易所拒绝：HTTP ${response.status}` };
    }
    await env.DB.prepare("UPDATE orders SET status='ACKNOWLEDGED', exchange_order_id=?, raw_response=?, updated_at=? WHERE client_order_id=?")
      .bind(exchangeOrderId(response.body), response.body, Date.now(), leg.clientOrderId).run();
    return { ok: true, clientOrderId: leg.clientOrderId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "委托状态未知";
    await env.DB.prepare("UPDATE orders SET status='AMBIGUOUS', error=?, updated_at=? WHERE client_order_id=?")
      .bind(message.slice(0, 500), Date.now(), leg.clientOrderId).run();
    return { ok: false, clientOrderId: leg.clientOrderId, error: `状态不明，禁止重发：${message}` };
  }
}

async function validateExecution(env: Env, mode: ExecutionMode, notionalUsd: number, confirmation: string, liveConfirmation?: string): Promise<Map<string, string>> {
  const settings = await settingsMap(env.DB);
  const configuredMode = (settings.get("mode") ?? "paper") as ExecutionMode;
  if (configuredMode !== mode) throw new HttpError(409, "运行模式已变化，请刷新后重试");
  if (confirmation !== "确认执行双腿交易") throw new HttpError(400, "请输入双腿交易确认语句");
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0 || notionalUsd > ABSOLUTE_MAX_ORDER_NOTIONAL_USD) throw new HttpError(400, "名义价值超出代码级硬上限");
  if (notionalUsd > Number(settings.get("max_order_notional_usd") ?? "2000")) throw new HttpError(400, "名义价值超过当前风控上限");
  if (mode !== "paper") {
    if (settings.get("execution_emergency_stop") !== "false") throw new HttpError(409, "紧急停止仍处于开启状态");
    if (settings.get("order_submission_enabled") !== "true") throw new HttpError(409, "真实委托总闸尚未打开");
    if (!env.EXECUTION_RELAY_URL) throw new HttpError(409, "固定 IP 执行中继尚未配置");
  }
  if (mode === "live") {
    if (settings.get("live_enabled") !== "true") throw new HttpError(409, "主网交易总闸尚未打开");
    if (liveConfirmation !== "我确认主网真实交易") throw new HttpError(400, "主网交易需要第二条确认语句");
  }
  return settings;
}

async function paperOpen(env: Env, hedgeId: string, body: OpenHedgeBody): Promise<Response> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO orders (client_order_id,hedge_intent_id,connection_id,leg,action,side,quantity,status,exchange_order_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'FILLED',?,?,?)")
      .bind(clientOrderId(hedgeId, "long", "open", 1), hedgeId, body.longConnectionId, "long", "open", "BUY", body.longQuantity, `paper-${crypto.randomUUID()}`, now, now),
    env.DB.prepare("INSERT INTO orders (client_order_id,hedge_intent_id,connection_id,leg,action,side,quantity,status,exchange_order_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'FILLED',?,?,?)")
      .bind(clientOrderId(hedgeId, "short", "open", 1), hedgeId, body.shortConnectionId, "short", "open", "SELL", body.shortQuantity, `paper-${crypto.randomUUID()}`, now, now),
    env.DB.prepare("UPDATE hedge_intents SET state='HEDGED', updated_at=? WHERE id=?").bind(now, hedgeId),
  ]);
  await writeAudit(env, "paper_hedge_opened", "INFO", { hedgeId, symbol: body.symbol, notionalUsd: body.notionalUsd });
  return json({ ok: true, hedgeId, state: "HEDGED", message: "Paper 双腿已模拟成交" }, 201);
}

async function openHedge(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const body = await readJson<OpenHedgeBody>(request);
  const mode = (await settingsMap(env.DB).then((settings) => settings.get("mode") ?? "paper")) as ExecutionMode;
  await validateExecution(env, mode, body.notionalUsd, body.confirmation, body.liveConfirmation);
  if (!body.idempotencyKey || body.idempotencyKey.length > 80) throw new HttpError(400, "幂等键无效");
  if (!validQuantity(body.longQuantity) || !validQuantity(body.shortQuantity)) throw new HttpError(400, "双腿数量必须是正数且最多 12 位小数");
  if (body.longConnectionId === body.shortConnectionId) throw new HttpError(400, "多头和空头必须使用不同连接");
  const symbol = normalizedSymbol(body.symbol);
  const [longConnection, shortConnection] = await Promise.all([connectionById(env, body.longConnectionId), connectionById(env, body.shortConnectionId)]);
  const requiredEnvironment: TradingEnvironment = mode === "live" ? "live" : "testnet";
  if (mode !== "paper" && (longConnection.environment !== requiredEnvironment || shortConnection.environment !== requiredEnvironment)) throw new HttpError(409, "连接环境与当前运行模式不一致");
  const enabledRows = await env.DB.prepare("SELECT id,enabled FROM exchange_connections WHERE id IN (?,?)").bind(body.longConnectionId, body.shortConnectionId).all<{ id: string; enabled: number }>();
  if (mode !== "paper" && (enabledRows.results ?? []).filter((row) => row.enabled === 1).length !== 2) throw new HttpError(409, "双边账户连接尚未启用");
  const hedgeId = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.prepare(`INSERT INTO hedge_intents
      (id,idempotency_key,mode,symbol,long_connection_id,short_connection_id,long_quantity,short_quantity,notional_usd,hard_leg,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'INTENT_SAVED', ?,?)`)
      .bind(hedgeId, body.idempotencyKey, mode, symbol, body.longConnectionId, body.shortConnectionId, body.longQuantity, body.shortQuantity, String(body.notionalUsd), body.hardLeg, now, now).run();
  } catch (error) {
    const existing = await env.DB.prepare("SELECT id,state FROM hedge_intents WHERE idempotency_key=?").bind(body.idempotencyKey).first<{ id: string; state: string }>();
    if (existing) return json({ ok: true, hedgeId: existing.id, state: existing.state, duplicate: true });
    throw error;
  }
  if (mode === "paper") return paperOpen(env, hedgeId, { ...body, symbol });

  const legs = {
    long: { connection: longConnection, quantity: body.longQuantity, direction: "long" as const },
    short: { connection: shortConnection, quantity: body.shortQuantity, direction: "short" as const },
  };
  const firstName = body.hardLeg;
  const secondName = firstName === "long" ? "short" : "long";
  const first = legs[firstName];
  const second = legs[secondName];
  const firstResult = await submitLeg(env, hedgeId, first.connection, firstName, { symbol, direction: first.direction, action: "open", quantity: first.quantity, clientOrderId: clientOrderId(hedgeId, firstName, "open", 1) });
  if (!firstResult.ok) {
    await env.DB.prepare("UPDATE hedge_intents SET state='FAILED_FLAT',error=?,updated_at=? WHERE id=?").bind(firstResult.error, Date.now(), hedgeId).run();
    throw new HttpError(502, firstResult.error ?? "第一腿委托失败");
  }
  const secondResult = await submitLeg(env, hedgeId, second.connection, secondName, { symbol, direction: second.direction, action: "open", quantity: second.quantity, clientOrderId: clientOrderId(hedgeId, secondName, "open", 1) });
  if (!secondResult.ok) {
    const rollback = await submitLeg(env, hedgeId, first.connection, firstName, { symbol, direction: first.direction, action: "rollback", quantity: first.quantity, clientOrderId: clientOrderId(hedgeId, firstName, "rollback", 1) });
    const state = rollback.ok ? "ROLLED_BACK" : "FAILED_UNHEDGED";
    await env.DB.prepare("UPDATE hedge_intents SET state=?,error=?,updated_at=? WHERE id=?").bind(state, secondResult.error, Date.now(), hedgeId).run();
    await writeAudit(env, "hedge_second_leg_failed", rollback.ok ? "DANGER" : "CRITICAL", { hedgeId, rollback: rollback.ok, error: secondResult.error });
    throw new HttpError(502, rollback.ok ? "第二腿失败，第一腿回滚请求已提交" : "第二腿失败且回滚失败，可能存在裸敞口");
  }
  await env.DB.prepare("UPDATE hedge_intents SET state='SUBMITTED_UNCONFIRMED',updated_at=? WHERE id=?").bind(Date.now(), hedgeId).run();
  await writeAudit(env, "hedge_submitted", "DANGER", { hedgeId, mode, symbol });
  return json({ ok: true, hedgeId, state: "SUBMITTED_UNCONFIRMED", message: "双腿已提交，需由对账流程确认成交" }, 201);
}

async function closeHedge(request: Request, env: Env, hedgeId: string): Promise<Response> {
  await requireAdmin(request, env);
  const body = await readJson<{ confirmation: string; liveConfirmation?: string }>(request);
  const row = await env.DB.prepare("SELECT * FROM hedge_intents WHERE id=?").bind(hedgeId).first<HedgeRow>();
  if (!row) throw new HttpError(404, "套保头寸不存在");
  if (!["HEDGED", "SUBMITTED_UNCONFIRMED", "CLOSE_PARTIAL"].includes(row.state)) throw new HttpError(409, `当前状态 ${row.state} 不允许平仓`);
  await validateExecution(env, row.mode, Number(row.notional_usd), body.confirmation, body.liveConfirmation);
  const [longConnection, shortConnection] = await Promise.all([connectionById(env, row.long_connection_id), connectionById(env, row.short_connection_id)]);
  const now = Date.now();
  await env.DB.prepare("UPDATE hedge_intents SET state='CLOSING',updated_at=? WHERE id=?").bind(now, hedgeId).run();
  if (row.mode === "paper") {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO orders (client_order_id,hedge_intent_id,connection_id,leg,action,side,quantity,status,exchange_order_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'FILLED',?,?,?)")
        .bind(clientOrderId(hedgeId, "long", "close", 1), hedgeId, row.long_connection_id, "long", "close", "SELL", row.long_quantity, `paper-${crypto.randomUUID()}`, now, now),
      env.DB.prepare("INSERT INTO orders (client_order_id,hedge_intent_id,connection_id,leg,action,side,quantity,status,exchange_order_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'FILLED',?,?,?)")
        .bind(clientOrderId(hedgeId, "short", "close", 1), hedgeId, row.short_connection_id, "short", "close", "BUY", row.short_quantity, `paper-${crypto.randomUUID()}`, now, now),
      env.DB.prepare("UPDATE hedge_intents SET state='CLOSED',updated_at=? WHERE id=?").bind(now, hedgeId),
    ]);
    return json({ ok: true, hedgeId, state: "CLOSED" });
  }
  const [longResult, shortResult] = await Promise.all([
    submitLeg(env, hedgeId, longConnection, "long", { symbol: row.symbol, direction: "long", action: "close", quantity: row.long_quantity, clientOrderId: clientOrderId(hedgeId, "long", "close", 1) }),
    submitLeg(env, hedgeId, shortConnection, "short", { symbol: row.symbol, direction: "short", action: "close", quantity: row.short_quantity, clientOrderId: clientOrderId(hedgeId, "short", "close", 1) }),
  ]);
  const state = longResult.ok && shortResult.ok ? "CLOSE_SUBMITTED" : "CLOSE_PARTIAL";
  await env.DB.prepare("UPDATE hedge_intents SET state=?,error=?,updated_at=? WHERE id=?")
    .bind(state, state === "CLOSE_PARTIAL" ? [longResult.error, shortResult.error].filter(Boolean).join("; ") : null, Date.now(), hedgeId).run();
  await writeAudit(env, "hedge_close_submitted", state === "CLOSE_PARTIAL" ? "CRITICAL" : "DANGER", { hedgeId, long: longResult.ok, short: shortResult.ok });
  return json({ ok: state !== "CLOSE_PARTIAL", hedgeId, state }, state === "CLOSE_PARTIAL" ? 502 : 200);
}

export async function handleTrading(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method === "POST" && pathname === "/api/admin/hedges") return openHedge(request, env);
  if (request.method === "POST" && /^\/api\/admin\/hedges\/[^/]+\/close$/.test(pathname)) return closeHedge(request, env, pathname.split("/").at(-2)!);
  throw new HttpError(404, "交易接口不存在");
}
