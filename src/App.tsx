import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowDownLeft, ArrowUpRight, Cable, CheckCircle2, CircleDollarSign,
  Database, KeyRound, LogOut, OctagonX, Plus, RefreshCw, Settings2, ShieldAlert,
  ShieldCheck, SlidersHorizontal, Unplug, WalletCards, XCircle,
} from "lucide-react";
import type { ControlPlaneStatus, ExecutionMode, HedgeRecord, TradingConnection } from "./lib/admin-types";
import type { ExchangeName, Opportunity, ScanResponse } from "./lib/types";

type View = "overview" | "opportunities" | "trade" | "connections" | "risk";

const TRADING_EXCHANGES: ExchangeName[] = ["Binance", "OKX", "Bybit", "Hyperliquid", "Gate.io", "Bitget", "WEEX", "HTX", "Coinbase"];
const EXCHANGE_CN: Record<string, string> = {
  Binance: "币安", Bybit: "Bybit", OKX: "OKX", Bitget: "Bitget", Hyperliquid: "Hyperliquid",
  "Gate.io": "Gate.io", WEEX: "WEEX", HTX: "HTX", Coinbase: "Coinbase",
};
const DEFAULT_QUERY = { feeBps: 5.5, slippageBps: 2, periods: 21, minApr: 12, minVolume: 50 };

function pct(value: number, digits = 2): string { return `${(value * 100).toFixed(digits)}%`; }
function rate(value: number): string { return `${value > 0 ? "+" : ""}${(value * 100).toFixed(4)}%`; }
function money(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function dateTime(value: number | null): string { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function stateLabel(value: string): string {
  const labels: Record<string, string> = { HEDGED: "已对冲", CLOSED: "已平仓", INTENT_SAVED: "意图已保存", SUBMITTED_UNCONFIRMED: "已提交待对账", CLOSE_SUBMITTED: "平仓已提交", CLOSE_PARTIAL: "部分平仓", ROLLED_BACK: "已回滚", FAILED_UNHEDGED: "存在裸敞口", FAILED_FLAT: "失败且已平" };
  return labels[value] ?? value;
}

function ExchangeBadge({ name }: { name: string }) {
  return <span className="exchange-badge">{name === "Hyperliquid" ? "HL" : name.slice(0, 2).toUpperCase()}</span>;
}

function ModeBadge({ mode }: { mode: ExecutionMode }) {
  return <span className={`mode-badge mode-${mode}`}>{mode === "paper" ? "Paper 模拟" : mode === "testnet" ? "Testnet 测试网" : "Live 主网"}</span>;
}

function OpportunityTable({ data, onTrade }: { data: ScanResponse | null; onTrade: (item: Opportunity) => void }) {
  const [search, setSearch] = useState("");
  const [onlyReady, setOnlyReady] = useState(false);
  const [exchangeFilter, setExchangeFilter] = useState("all");
  const rows = useMemo(() => (data?.opportunities ?? []).filter((item) =>
    (!onlyReady || item.executable)
    && (!search || item.symbol.includes(search.toUpperCase()))
    && (exchangeFilter === "all" || item.longExchange === exchangeFilter || item.shortExchange === exchangeFilter),
  ), [data, exchangeFilter, onlyReady, search]);
  return (
    <section className="panel opportunity-panel">
      <div className="panel-heading">
        <div><p className="kicker">实时资金费率</p><h2>跨交易所机会</h2><span>已统一到 8 小时，并扣除四腿手续费与滑点</span></div>
        <div className="table-actions"><select aria-label="筛选交易所" value={exchangeFilter} onChange={(event) => setExchangeFilter(event.target.value)}><option value="all">全部交易所</option>{data?.health.map((item) => <option key={item.exchange} value={item.exchange}>{EXCHANGE_CN[item.exchange]} · {item.ok ? `${item.quoteCount} 对` : "不可用"}</option>)}</select><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索币种" /><button className={onlyReady ? "active" : ""} onClick={() => setOnlyReady(!onlyReady)}>仅看达标</button><span className="row-count">{rows.length} 条</span></div>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>合约</th><th>双腿路径</th><th>8h 费率差</th><th>成本后 APR</th><th>预计回本</th><th>较弱侧流动性</th><th>评估</th><th /></tr></thead>
          <tbody>{rows.slice(0, 60).map((item) => <tr key={`${item.symbol}-${item.longExchange}-${item.shortExchange}`}>
            <td><strong className="symbol">{item.symbol}</strong><small>{item.longQuoteAsset === item.shortQuoteAsset ? item.longQuoteAsset : `${item.longQuoteAsset}/${item.shortQuoteAsset}`} 永续</small></td>
            <td><div className="route"><span><ExchangeBadge name={item.longExchange} />{EXCHANGE_CN[item.longExchange]} <b className="long"><ArrowUpRight size={15} />做多</b></span><span><ExchangeBadge name={item.shortExchange} />{EXCHANGE_CN[item.shortExchange]} <b className="short"><ArrowDownLeft size={15} />做空</b></span></div></td>
            <td className="number"><strong>{rate(item.spread8h)}</strong><small>{rate(item.longRate8h)} → {rate(item.shortRate8h)}</small></td>
            <td className="number"><strong className={item.expectedNetApr >= 0.12 ? "red" : ""}>{pct(item.expectedNetApr, 1)}</strong><small>持有 {data?.params.holdingPeriods ?? 21} 期</small></td>
            <td className="number">{item.minHoldingPeriods} 期<small>约 {Math.ceil(item.minHoldingPeriods / 3)} 天</small></td>
            <td className="number">{money(item.liquidityUsd)}</td>
            <td><span className={`result-tag ${item.executable ? "qualified" : "watch"}`}>{item.executable ? "达标" : "观察"}</span></td>
            <td><button className="row-action" onClick={() => onTrade(item)} disabled={!item.executable}>{item.executable ? "创建交易" : "仅观察"}</button></td>
          </tr>)}</tbody>
        </table>
        {rows.length === 0 && <div className="empty-state">当前筛选条件下没有机会。</div>}
      </div>
    </section>
  );
}

function AccessGate({ error }: { error: string }) {
  return <section className="unlock-card"><div className="unlock-icon"><KeyRound size={30} /></div><div><p className="kicker">Cloudflare Access</p><h2>使用 Google 邮箱登录</h2><p>控制台仅允许 <strong>hans.pan007@gmail.com</strong>。Cloudflare 会向该 Gmail 发送一次性验证码；应用还会验证 Access JWT、应用受众和邮箱，无法通过伪造请求头登录。</p><div className="access-actions"><button className="primary-button" onClick={() => window.location.reload()}>重新验证登录</button><span>无需再复制管理 Token</span></div>{error && <p className="form-error">{error}</p>}</div></section>;
}

function ConnectionsView({ status, request, refresh }: { status: ControlPlaneStatus; request: (path: string, init?: RequestInit) => Promise<unknown>; refresh: () => Promise<void> }) {
  const [form, setForm] = useState({ exchange: "Binance", environment: "testnet", label: "", apiKey: "", apiSecret: "", passphrase: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await request("/api/admin/connections", { method: "POST", body: JSON.stringify(form) }) as { message?: string };
      setMessage(result.message ?? "连接已保存"); setForm({ ...form, label: "", apiKey: "", apiSecret: "", passphrase: "" }); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); } finally { setBusy(false); }
  }
  async function action(path: string, init?: RequestInit) { setBusy(true); setError(""); try { await request(path, init); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); } finally { setBusy(false); } }
  const needsPassphrase = ["OKX", "Bitget", "WEEX", "Coinbase"].includes(form.exchange);
  const liveOnly = form.exchange === "HTX";
  const hyperliquid = form.exchange === "Hyperliquid";
  useEffect(() => { if (liveOnly && form.environment !== "live") setForm((current) => ({ ...current, environment: "live" })); }, [form.environment, liveOnly]);
  return <div className="two-column">
    <section className="panel form-panel"><div className="panel-heading"><div><p className="kicker">API 保险箱</p><h2>添加交易所账户</h2><span>9 家交易所均已建立验权与下单适配；建议使用独立子账户、禁提现并绑定固定 IP。币安、OKX、Bitget 请设置为单向/净持仓模式。</span></div><KeyRound className="heading-icon" /></div>
      <div className="form-grid">
        <label>交易所<select value={form.exchange} onChange={(event) => setForm({ ...form, exchange: event.target.value })}>{TRADING_EXCHANGES.map((item) => <option key={item} value={item}>{EXCHANGE_CN[item]}</option>)}</select></label>
        <label>账户环境<select value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value })} disabled={liveOnly}>{!liveOnly && <option value="testnet">Testnet 测试网</option>}<option value="live">Live 主网</option></select></label>
        <label className="wide">连接名称<input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="例如：币安套保子账户" /></label>
        <label className="wide">{hyperliquid ? "Agent Wallet 地址" : "API Key"}<input type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} autoComplete="off" /></label>
        <label className="wide">{hyperliquid ? "Agent Wallet 私钥" : "API Secret"}<input type="password" value={form.apiSecret} onChange={(event) => setForm({ ...form, apiSecret: event.target.value })} autoComplete="off" /></label>
        {needsPassphrase && <label className="wide">Passphrase<input type="password" value={form.passphrase} onChange={(event) => setForm({ ...form, passphrase: event.target.value })} autoComplete="off" /></label>}
      </div>
      <div className="connector-coverage"><p><strong>接入范围</strong><span>币安、OKX、Bybit、Hyperliquid、Gate.io、Bitget、WEEX、HTX、Coinbase</span></p><p><strong>重要差异</strong><span>Hyperliquid 与 Coinbase INTX 为 USDC 结算；跨 USDT/USDC 路径只观察，后端也会拒绝提交。Hyperliquid 请使用独立 Agent Wallet。</span></p></div>
      <div className="security-note"><ShieldCheck size={19} /><span>AES-256-GCM 加密 · 主密钥仅存在 Cloudflare Secret · D1 不保存明文 · 每次加密使用独立随机 IV</span></div>
      {error && <p className="form-error">{error}</p>}{message && <p className="form-success">{message}</p>}
      <button className="primary-button full" onClick={save} disabled={busy}>保存到加密保险箱</button>
    </section>
    <section className="panel"><div className="panel-heading"><div><p className="kicker">连接状态</p><h2>已保存账户</h2><span>{status.relayConfigured ? "固定 IP 中继已配置" : "尚未配置固定 IP 中继，暂不能验权或真实下单"}</span></div><Cable className="heading-icon" /></div>
      <div className="connection-list">{status.connections.map((item) => <article key={item.id} className="connection-item"><div className="connection-main"><ExchangeBadge name={item.exchange} /><div><strong>{item.label}</strong><span>{EXCHANGE_CN[item.exchange]} · {item.environment === "live" ? "主网" : "测试网"} · 指纹 {item.fingerprint}</span></div></div><div className="connection-status"><span className={`dot ${item.verificationStatus === "verified" ? "ok" : item.verificationStatus === "failed" ? "danger" : "idle"}`} />{item.verificationStatus === "verified" ? "验权通过" : item.verificationStatus === "failed" ? "验权失败" : "待验权"}</div><div className="connection-actions"><button onClick={() => action(`/api/admin/connections/${item.id}/verify`, { method: "POST" })} disabled={busy || !status.relayConfigured}>验权</button><button onClick={() => action(`/api/admin/connections/${item.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !item.enabled }) })} disabled={busy || (item.verificationStatus !== "verified" && !item.enabled)}>{item.enabled ? "停用" : "启用"}</button></div>{item.lastError && <p className="connection-error">{item.lastError}</p>}</article>)}{status.connections.length === 0 && <div className="empty-state"><Unplug size={28} />尚未添加交易所账户</div>}</div>
    </section>
  </div>;
}

function TradeView({ status, selected, request, refresh }: { status: ControlPlaneStatus; selected: Opportunity | null; request: (path: string, init?: RequestInit) => Promise<unknown>; refresh: () => Promise<void> }) {
  const [form, setForm] = useState({ symbol: selected?.symbol ?? "BTC", longConnectionId: "", shortConnectionId: "", longQuantity: "", shortQuantity: "", notionalUsd: "100", hardLeg: "long", confirmation: "", liveConfirmation: "" });
  const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (selected) setForm((current) => ({ ...current, symbol: selected.symbol })); }, [selected]);
  const connections = status.connections.filter((item) => item.enabled || status.settings.mode === "paper");
  async function submit() { setBusy(true); setError(""); setMessage(""); try { const result = await request("/api/admin/hedges", { method: "POST", body: JSON.stringify({ ...form, notionalUsd: Number(form.notionalUsd), idempotencyKey: crypto.randomUUID() }) }) as { message?: string; state?: string }; setMessage(result.message ?? `交易状态：${result.state}`); setForm({ ...form, confirmation: "", liveConfirmation: "" }); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "交易提交失败"); } finally { setBusy(false); } }
  async function close(item: HedgeRecord) { setBusy(true); setError(""); try { await request(`/api/admin/hedges/${item.id}/close`, { method: "POST", body: JSON.stringify({ confirmation: "确认执行双腿交易", liveConfirmation: item.mode === "live" ? "我确认主网真实交易" : undefined }) }); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "平仓提交失败"); } finally { setBusy(false); } }
  return <div className="trade-layout"><section className="panel form-panel"><div className="panel-heading"><div><p className="kicker">双腿执行</p><h2>创建套保交易</h2><span>难腿优先；第二腿失败时自动提交第一腿 reduce-only 回滚</span></div><ModeBadge mode={status.settings.mode} /></div>
    <div className="execution-warning"><AlertTriangle size={20} /><span>{status.settings.mode === "paper" ? "当前为 Paper 模式，只记录模拟成交。" : status.settings.executionEmergencyStop ? "紧急停止已开启，真实委托会被拒绝。" : "真实委托已进入可执行链路，请核对数量与账户环境。"}</span></div>
    <div className="form-grid">
      <label>交易对<input value={form.symbol} onChange={(event) => setForm({ ...form, symbol: event.target.value.toUpperCase() })} /></label>
      <label>单边名义价值<input type="number" min="10" max="10000" value={form.notionalUsd} onChange={(event) => setForm({ ...form, notionalUsd: event.target.value })} /><small>USDT</small></label>
      <label>多头账户<select value={form.longConnectionId} onChange={(event) => setForm({ ...form, longConnectionId: event.target.value })}><option value="">请选择</option>{connections.map((item) => <option key={item.id} value={item.id}>{item.label} · {EXCHANGE_CN[item.exchange]}</option>)}</select></label>
      <label>多头数量<input value={form.longQuantity} onChange={(event) => setForm({ ...form, longQuantity: event.target.value })} placeholder="按交易所数量精度填写" /></label>
      <label>空头账户<select value={form.shortConnectionId} onChange={(event) => setForm({ ...form, shortConnectionId: event.target.value })}><option value="">请选择</option>{connections.map((item) => <option key={item.id} value={item.id}>{item.label} · {EXCHANGE_CN[item.exchange]}</option>)}</select></label>
      <label>空头数量<input value={form.shortQuantity} onChange={(event) => setForm({ ...form, shortQuantity: event.target.value })} placeholder="按交易所数量精度填写" /></label>
      <label>难腿优先<select value={form.hardLeg} onChange={(event) => setForm({ ...form, hardLeg: event.target.value })}><option value="long">多头腿优先</option><option value="short">空头腿优先</option></select></label>
      <label>交易确认<input value={form.confirmation} onChange={(event) => setForm({ ...form, confirmation: event.target.value })} placeholder="输入：确认执行双腿交易" /></label>
      {status.settings.mode === "live" && <label className="wide danger-field">主网二次确认<input value={form.liveConfirmation} onChange={(event) => setForm({ ...form, liveConfirmation: event.target.value })} placeholder="输入：我确认主网真实交易" /></label>}
    </div>{error && <p className="form-error">{error}</p>}{message && <p className="form-success">{message}</p>}<button className="primary-button full" onClick={submit} disabled={busy || !form.longConnectionId || !form.shortConnectionId}>{busy ? "正在处理" : status.settings.mode === "paper" ? "创建 Paper 套保" : "提交双腿委托"}</button>
  </section><section className="panel"><div className="panel-heading"><div><p className="kicker">持仓与任务</p><h2>最近套保记录</h2><span>交易所回报是唯一真相源；SUBMITTED 状态仍需固定主机持续对账</span></div><RefreshCw size={21} /></div><div className="hedge-list">{status.hedges.map((item) => <article key={item.id} className="hedge-item"><div><strong>{item.symbol} / USDT</strong><ModeBadge mode={item.mode} /></div><p><span>状态</span><b className={item.state.includes("FAILED") || item.state.includes("PARTIAL") ? "danger-text" : ""}>{stateLabel(item.state)}</b></p><p><span>名义价值</span><b>{item.notionalUsd} USDT / 单边</b></p><p><span>建立时间</span><b>{dateTime(item.createdAt)}</b></p>{["HEDGED", "SUBMITTED_UNCONFIRMED", "CLOSE_PARTIAL"].includes(item.state) && <button className="outline-button" onClick={() => close(item)} disabled={busy}>双腿平仓</button>}</article>)}{status.hedges.length === 0 && <div className="empty-state">尚无套保交易记录</div>}</div></section></div>;
}

function RiskView({ status, request, refresh }: { status: ControlPlaneStatus; request: (path: string, init?: RequestInit) => Promise<unknown>; refresh: () => Promise<void> }) {
  const [confirmation, setConfirmation] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function update(patch: Record<string, unknown>) { setBusy(true); setError(""); try { await request("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ ...patch, confirmation }) }); setConfirmation(""); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "设置更新失败"); } finally { setBusy(false); } }
  return <div className="risk-layout"><section className="panel"><div className="panel-heading"><div><p className="kicker">三道交易锁</p><h2>执行总闸</h2><span>从左到右逐层开放；生产事故时只需重新开启紧急停止</span></div><ShieldAlert className="heading-icon" /></div><div className="gate-stack">
    <article className={status.settings.executionEmergencyStop ? "closed" : "open"}><div><OctagonX size={24} /><strong>紧急停止</strong><span>{status.settings.executionEmergencyStop ? "已开启：拒绝所有真实委托" : "已解除：进入下一道检查"}</span></div><button onClick={() => update({ executionEmergencyStop: !status.settings.executionEmergencyStop })} disabled={busy}>{status.settings.executionEmergencyStop ? "解除" : "立即停止"}</button></article>
    <article className={status.settings.orderSubmissionEnabled ? "open" : "closed"}><div><WalletCards size={24} /><strong>真实委托许可</strong><span>{status.settings.orderSubmissionEnabled ? "已允许向中继提交委托" : "已关闭：仅可使用 Paper"}</span></div><button onClick={() => update({ orderSubmissionEnabled: !status.settings.orderSubmissionEnabled })} disabled={busy}>{status.settings.orderSubmissionEnabled ? "关闭" : "开启"}</button></article>
    <article className={status.settings.liveEnabled ? "open" : "closed"}><div><CircleDollarSign size={24} /><strong>主网交易许可</strong><span>{status.settings.liveEnabled ? "已开启：主网真实资金可交易" : "已关闭：最多运行 Testnet"}</span></div><button onClick={() => update({ liveEnabled: !status.settings.liveEnabled })} disabled={busy}>{status.settings.liveEnabled ? "关闭" : "开启"}</button></article>
  </div><label className="confirmation-field">降低安全级别前输入确认语句<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="我确认调整交易总闸" /></label>{error && <p className="form-error">{error}</p>}</section>
  <section className="panel"><div className="panel-heading"><div><p className="kicker">运行环境</p><h2>模式与硬上限</h2><span>主网模式不会自动解除任何交易总闸</span></div><Settings2 className="heading-icon" /></div><div className="mode-selector">{(["paper", "testnet", "live"] as ExecutionMode[]).map((mode) => <button key={mode} className={status.settings.mode === mode ? "active" : ""} onClick={() => update({ mode })} disabled={busy}><ModeBadge mode={mode} /><span>{mode === "paper" ? "模拟双腿与完整账本" : mode === "testnet" ? "交易所测试环境" : "真实资金主网"}</span></button>)}</div><div className="limit-grid"><div><span>单组名义上限</span><strong>{status.settings.maxOrderNotionalUsd.toLocaleString()} USDT</strong></div><div><span>有效杠杆上限</span><strong>{status.settings.maxEffectiveLeverage.toFixed(1)}×</strong></div><div><span>固定 IP 中继</span><strong className={status.relayConfigured ? "success-text" : "danger-text"}>{status.relayConfigured ? "已连接" : "未配置"}</strong></div></div></section></div>;
}

function Overview({ data, status, setView }: { data: ScanResponse | null; status: ControlPlaneStatus | null; setView: (view: View) => void }) {
  const best = data?.opportunities.find((item) => item.executable);
  const ready = data?.opportunities.filter((item) => item.executable).length ?? 0;
  return <><section className="overview-hero"><div><p className="kicker">个人跨所套保终端</p><h1>扫描费率，<br /><em>执行双腿交易。</em></h1><p>统一管理交易所账户、资金费率机会、双腿委托、持仓和平仓。每一次真实订单都经过账户隔离、名义上限、幂等键、紧急停止和固定 IP 中继。</p><div className="hero-actions"><button className="primary-button" onClick={() => setView("opportunities")}>查看套利机会</button><button className="text-button" onClick={() => setView("trade")}>进入双腿交易 →</button></div></div><aside><p>当前最优达标机会</p><strong>{best ? pct(best.expectedNetApr, 1) : "—"}</strong><span>{best ? `${best.symbol} · ${EXCHANGE_CN[best.longExchange]}多 / ${EXCHANGE_CN[best.shortExchange]}空` : "暂无同时满足收益与流动性门槛的机会"}</span><small>成本后估算，不构成收益承诺</small></aside></section>
    <section className="metric-grid"><article><Activity /><span>达标机会</span><strong>{ready}</strong><small>实时成本模型</small></article><article><Database /><span>共同交易对</span><strong>{data?.commonSymbolCount ?? "—"}</strong><small>至少覆盖两个平台</small></article><article><Cable /><span>已启用账户</span><strong>{status?.connections.filter((item) => item.enabled).length ?? "—"}</strong><small>加密连接</small></article><article><ShieldCheck /><span>当前模式</span><strong className="mode-text">{status ? <ModeBadge mode={status.settings.mode} /> : "验证中"}</strong><small>{status?.settings.executionEmergencyStop === false ? "交易链路待命" : "紧急停止保护中"}</small></article></section>
    <section className="workflow-section"><div className="section-title"><p className="kicker">完整工作流</p><h2>从机会发现到双腿退出</h2></div><div className="workflow-line"><article><b>01</b><h3>连接账户</h3><p>子账户 API 加密保存在 Cloudflare，禁提现并绑定固定出口 IP。</p></article><article><b>02</b><h3>筛选机会</h3><p>归一化费率、手续费、滑点、回本周期和双边流动性。</p></article><article><b>03</b><h3>双腿执行</h3><p>难腿优先，持久化幂等订单，第二腿失败自动发起回滚。</p></article><article><b>04</b><h3>监控与退出</h3><p>跟踪净 Delta、保证金、费率反转，并用 reduce-only 双腿平仓。</p></article></div></section>
    <section className="dashboard-lower"><div className="panel compact"><div className="panel-heading"><div><p className="kicker">数据连接</p><h2>交易所状态</h2><span>{data ? `${data.healthySourceCount}/${data.sourceCount} 个来源在线，共 ${data.quoteCount} 条永续合约费率` : "正在连接行情源"}</span></div></div><div className="source-grid">{data?.health.map((item) => <div key={item.exchange}><ExchangeBadge name={item.exchange} /><span>{EXCHANGE_CN[item.exchange]}</span><b className={item.ok ? "success-text" : "danger-text"}>{item.ok ? `${item.quoteCount} 对` : "不可用"}</b>{!item.ok && <small title={item.error}>{item.error ?? "上游接口异常"}</small>}</div>)}</div></div><div className="panel compact risk-summary"><div><p className="kicker">安全状态</p><h2>{status ? (status.settings.executionEmergencyStop ? "真实委托已停止" : "真实委托链路待命") : "正在验证交易身份"}</h2><p>{status ? `当前为 ${status.settings.mode.toUpperCase()} 模式；固定 IP 中继${status.relayConfigured ? "已配置" : "未配置"}。` : "Cloudflare 邮箱身份验证完成后即可管理账户、执行总闸和套保持仓。"}</p></div><button className="outline-button" onClick={() => setView(status ? "risk" : "connections")}>查看安全设置</button></div></section></>;
}

export default function App() {
  const [view, setView] = useState<View>("overview");
  const [data, setData] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [publicError, setPublicError] = useState("");
  const [filters, setFilters] = useState(DEFAULT_QUERY);
  const [draft, setDraft] = useState(DEFAULT_QUERY);
  const [status, setStatus] = useState<ControlPlaneStatus | null>(null);
  const [adminError, setAdminError] = useState("");
  const [selectedOpportunity, setSelectedOpportunity] = useState<Opportunity | null>(null);

  const loadScan = useCallback(async () => {
    setLoading(true); setPublicError("");
    const params = new URLSearchParams({ feeBps: String(filters.feeBps), slippageBps: String(filters.slippageBps), periods: String(filters.periods), maxPeriods: String(filters.periods), minApr: String(filters.minApr / 100), minVolume: String(filters.minVolume * 1_000_000) });
    try { const response = await fetch(`/api/scan?${params}`); if (!response.ok && response.status !== 503) throw new Error(`扫描服务返回 ${response.status}`); setData(await response.json() as ScanResponse); } catch (cause) { setPublicError(cause instanceof Error ? cause.message : "行情扫描暂不可用"); } finally { setLoading(false); }
  }, [filters]);
  const adminRequest = useCallback(async (path: string, init: RequestInit = {}) => {
    const response = await fetch(path, { ...init, credentials: "same-origin", headers: { "content-type": "application/json", ...init.headers } });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() as { error?: string } : { error: "Cloudflare Access 登录会话无效" };
    if (!response.ok) throw new Error(body.error ?? `请求失败：${response.status}`);
    return body;
  }, []);
  const refreshStatus = useCallback(async () => { setStatus(await adminRequest("/api/admin/status") as ControlPlaneStatus); setAdminError(""); }, [adminRequest]);
  function logout() { window.location.assign("/cdn-cgi/access/logout"); }

  useEffect(() => { void loadScan(); }, [loadScan]);
  useEffect(() => { void refreshStatus().catch((cause) => { setStatus(null); setAdminError(cause instanceof Error ? cause.message : "Google 邮箱登录会话无效"); }); }, [refreshStatus]);
  useEffect(() => { const timer = window.setInterval(() => void loadScan(), 30_000); return () => window.clearInterval(timer); }, [loadScan]);

  function openTrade(item: Opportunity) { setSelectedOpportunity(item); setView("trade"); window.scrollTo({ top: 0, behavior: "smooth" }); }
  const protectedView = view === "trade" || view === "connections" || view === "risk";

  return <div className="app-shell"><a className="skip-link" href="#main">跳到主要内容</a><header><div className="header-inner"><button className="brand" onClick={() => setView("overview")}><span className="brand-seal">套</span><span><strong>FundArb</strong><small>跨所套保交易终端</small></span></button><nav>{[["overview", "总览"], ["opportunities", "套利机会"], ["trade", "双腿交易"], ["connections", "账户连接"], ["risk", "风控中心"]].map(([key, label]) => <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key as View)}>{label}</button>)}</nav><div className="header-tools"><span className={`market-state ${data?.healthySourceCount ? "online" : ""}`}><i />{data?.healthySourceCount ?? 0}/{data?.sourceCount ?? 9} 数据源</span><button className="icon-button" aria-label="刷新" onClick={() => void loadScan()}><RefreshCw size={19} className={loading ? "spin" : ""} /></button>{status ? <button className="operator-button" onClick={logout} title={status.identityEmail}><LogOut size={17} />{status.authenticationMethod === "cloudflare-access" ? "退出邮箱登录" : "退出应急会话"}</button> : <button className="operator-button" onClick={() => setView("connections")}><KeyRound size={17} />Google 邮箱登录</button>}</div></div></header>
    <main id="main" className="main-container">{publicError && <div className="banner danger"><XCircle size={20} />{publicError}</div>}
      {view === "overview" && <Overview data={data} status={status} setView={setView} />}
      {view === "opportunities" && <><div className="page-heading"><div><p className="kicker">资金费率扫描</p><h1>套利机会</h1><p>观察值不是下单指令。进入交易前还需核对盘口深度、账户余额与保证金安全垫。</p></div><button className="icon-button large" onClick={() => void loadScan()}><RefreshCw size={21} className={loading ? "spin" : ""} /></button></div><section className="filter-panel"><div><SlidersHorizontal size={20} /><strong>收益假设</strong></div><label>单腿手续费 <b>{draft.feeBps} bp</b><input type="range" min="0" max="15" step="0.5" value={draft.feeBps} onChange={(e) => setDraft({ ...draft, feeBps: Number(e.target.value) })} /></label><label>单腿滑点 <b>{draft.slippageBps} bp</b><input type="range" min="0" max="20" step="0.5" value={draft.slippageBps} onChange={(e) => setDraft({ ...draft, slippageBps: Number(e.target.value) })} /></label><label>计划持有 <b>{draft.periods} 期</b><input type="range" min="3" max="90" step="3" value={draft.periods} onChange={(e) => setDraft({ ...draft, periods: Number(e.target.value) })} /></label><label>最低净 APR <b>{draft.minApr}%</b><input type="range" min="0" max="50" value={draft.minApr} onChange={(e) => setDraft({ ...draft, minApr: Number(e.target.value) })} /></label><button className="primary-button" onClick={() => setFilters(draft)}>重新计算</button></section><OpportunityTable data={data} onTrade={openTrade} /></>}
      {protectedView && !status && <AccessGate error={adminError} />}
      {view === "connections" && status && <ConnectionsView status={status} request={adminRequest} refresh={refreshStatus} />}
      {view === "trade" && status && <TradeView status={status} selected={selectedOpportunity} request={adminRequest} refresh={refreshStatus} />}
      {view === "risk" && status && <RiskView status={status} request={adminRequest} refresh={refreshStatus} />}
    </main><footer><div><strong>FundArb</strong><span>个人跨所套保交易终端</span></div><p>永续合约、基差、资金费率、交易所信用与 API 故障均可能造成本金损失。系统默认关闭真实委托。</p><a href="https://github.com/Hans010101/fundarb" target="_blank" rel="noreferrer">查看公开代码 ↗</a></footer></div>;
}
