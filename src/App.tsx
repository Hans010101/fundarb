import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, ArrowDownLeft, ArrowUpRight, ChevronDown, CircleAlert, Clock3, Database, RefreshCw, ShieldCheck, SlidersHorizontal, Zap } from "lucide-react";
import type { Opportunity, ScanResponse } from "./lib/types";

const EXCHANGE_LABEL: Record<string, string> = {
  Binance: "BN",
  Bybit: "BY",
  OKX: "OK",
  Bitget: "BG",
  Hyperliquid: "HL",
};

const DEFAULT_QUERY = { feeBps: 5.5, slippageBps: 2, periods: 21, minApr: 12, minVolume: 50 };

function pct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function rate(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(4)}%`;
}

function money(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return seconds < 5 ? "刚刚" : `${seconds} 秒前`;
}

function nextFunding(timestamp: number | null): string {
  if (!timestamp) return "—";
  const delta = timestamp - Date.now();
  if (delta <= 0) return "结算中";
  const hours = Math.floor(delta / 3_600_000);
  const minutes = Math.floor((delta % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

function ExchangeBadge({ name }: { name: string }) {
  return <span className={`exchange exchange-${EXCHANGE_LABEL[name]?.toLowerCase()}`}>{EXCHANGE_LABEL[name] ?? name.slice(0, 2)}</span>;
}

function RouteCell({ opportunity }: { opportunity: Opportunity }) {
  return (
    <div className="route-cell">
      <div><ExchangeBadge name={opportunity.longExchange} /><span>{opportunity.longExchange}</span><span className="route-action long"><ArrowUpRight size={12} />多</span></div>
      <div className="route-line" />
      <div><ExchangeBadge name={opportunity.shortExchange} /><span>{opportunity.shortExchange}</span><span className="route-action short"><ArrowDownLeft size={12} />空</span></div>
    </div>
  );
}

function OpportunityRow({ item }: { item: Opportunity }) {
  return (
    <tr>
      <td className="rank">{String(item.rank).padStart(2, "0")}</td>
      <td><strong className="symbol">{item.symbol}</strong><span className="perp">USDT PERP</span></td>
      <td><RouteCell opportunity={item} /></td>
      <td className="mono"><span className={item.longRate8h < 0 ? "positive" : ""}>{rate(item.longRate8h)}</span><span className="sub">多头端 / 8h</span></td>
      <td className="mono"><span className={item.shortRate8h > 0 ? "positive" : ""}>{rate(item.shortRate8h)}</span><span className="sub">空头端 / 8h</span></td>
      <td className="mono spread"><strong>{rate(item.spread8h)}</strong><span className="sub">毛差</span></td>
      <td className="mono"><strong className={item.expectedNetApr >= 0.12 ? "positive" : "muted"}>{pct(item.expectedNetApr, 1)}</strong><span className="sub">成本后估算</span></td>
      <td className="mono"><span>{item.minHoldingPeriods} 期</span><span className="sub">约 {Math.ceil(item.minHoldingPeriods / 3)} 天</span></td>
      <td className="mono"><span>{money(item.liquidityUsd)}</span><span className="sub">较弱一侧</span></td>
      <td><span className={item.executable ? "status ready" : "status watch"}><i />{item.executable ? "候选" : "观察"}</span></td>
      <td className="mono muted">{nextFunding(item.nextFundingTime)}</td>
    </tr>
  );
}

function App() {
  const [data, setData] = useState<ScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastTick, setLastTick] = useState(Date.now());
  const [filters, setFilters] = useState(DEFAULT_QUERY);
  const [draft, setDraft] = useState(DEFAULT_QUERY);
  const [onlyExecutable, setOnlyExecutable] = useState(false);
  const [search, setSearch] = useState("");
  const [showMethod, setShowMethod] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      feeBps: String(filters.feeBps),
      slippageBps: String(filters.slippageBps),
      periods: String(filters.periods),
      maxPeriods: String(filters.periods),
      minApr: String(filters.minApr / 100),
      minVolume: String(filters.minVolume * 1_000_000),
    });
    try {
      const response = await fetch(`/api/scan?${params}`);
      if (!response.ok && response.status !== 503) throw new Error(`扫描服务返回 ${response.status}`);
      setData((await response.json()) as ScanResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法连接扫描服务");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => setLastTick(Date.now()), 1_000);
    const refresh = window.setInterval(() => void load(), 30_000);
    return () => { window.clearInterval(timer); window.clearInterval(refresh); };
  }, [load]);

  const opportunities = useMemo(() => {
    const needle = search.trim().toUpperCase();
    return (data?.opportunities ?? []).filter((item) => (!onlyExecutable || item.executable) && (!needle || item.symbol.includes(needle)));
  }, [data, onlyExecutable, search]);
  const readyCount = data?.opportunities.filter((item) => item.executable).length ?? 0;
  const best = data?.opportunities[0];
  const healthy = data?.health.filter((item) => item.ok).length ?? 0;
  void lastTick;

  return (
    <div className="app-shell">
      <header>
        <div className="brand">
          <div className="brand-mark"><span /><span /></div>
          <div><h1>FUND<span>ARB</span></h1><p>CROSS-EXCHANGE FUNDING INTELLIGENCE</p></div>
        </div>
        <nav><a href="#radar" className="active">机会雷达</a><a href="#method">收益模型</a><a href="#risk">风险边界</a></nav>
        <div className="header-status"><span className="live-dot" />{healthy}/5 数据源在线 <button onClick={() => void load()} aria-label="刷新"><RefreshCw size={15} className={loading ? "spin" : ""} /></button></div>
      </header>

      <main>
        <section className="hero" id="radar">
          <div>
            <div className="eyebrow"><span /> LIVE MARKET SCAN · 8H NORMALIZED</div>
            <h2>资金费率差，<br /><em>看见净收益。</em></h2>
            <p>同时比较五个主流永续市场。先归一化结算周期，再扣除四腿手续费与滑点，不用虚高毛年化误导决策。</p>
          </div>
          <div className="hero-metric">
            <span>当前最优成本后年化</span>
            <strong>{best ? pct(best.expectedNetApr, 1) : "—"}</strong>
            <div>{best ? `${best.symbol} · ${best.longExchange} 多 / ${best.shortExchange} 空` : "等待数据"}</div>
            <small>按持有 {filters.periods} 个 8h 周期估算，不构成收益承诺</small>
          </div>
        </section>

        <section className="stats-grid">
          <article><Database size={18} /><div><span>标准化行情</span><strong>{data?.quoteCount ?? "—"}</strong><small>条实时资金费率</small></div></article>
          <article><Activity size={18} /><div><span>共同交易对</span><strong>{data?.commonSymbolCount ?? "—"}</strong><small>至少覆盖两个平台</small></div></article>
          <article><Zap size={18} /><div><span>满足全部门槛</span><strong>{readyCount}</strong><small>仅为研究候选</small></div></article>
          <article><ShieldCheck size={18} /><div><span>执行总闸</span><strong className="safe">关闭</strong><small>市场数据模式</small></div></article>
        </section>

        <section className="control-panel">
          <div className="panel-title"><SlidersHorizontal size={17} /><div><strong>成本与持仓假设</strong><span>修改参数后重新计算</span></div></div>
          <label>单腿手续费 <span>{draft.feeBps} bp</span><input type="range" min="0" max="15" step="0.5" value={draft.feeBps} onChange={(e) => setDraft({ ...draft, feeBps: Number(e.target.value) })} /></label>
          <label>单腿滑点 <span>{draft.slippageBps} bp</span><input type="range" min="0" max="20" step="0.5" value={draft.slippageBps} onChange={(e) => setDraft({ ...draft, slippageBps: Number(e.target.value) })} /></label>
          <label>计划持有 <span>{draft.periods} 期</span><input type="range" min="3" max="90" step="3" value={draft.periods} onChange={(e) => setDraft({ ...draft, periods: Number(e.target.value) })} /></label>
          <label>最低净 APR <span>{draft.minApr}%</span><input type="range" min="0" max="50" step="1" value={draft.minApr} onChange={(e) => setDraft({ ...draft, minApr: Number(e.target.value) })} /></label>
          <button className="apply" onClick={() => setFilters(draft)}>应用参数</button>
        </section>

        {error && <div className="alert error"><CircleAlert size={17} />{error}</div>}
        {data?.warnings[0] && <div className="alert"><CircleAlert size={17} /><span>{data.warnings[0]}</span></div>}

        <section className="table-section">
          <div className="section-head">
            <div><span className="section-index">01</span><h3>跨所机会矩阵</h3><p>按可执行性与成本后年化排序</p></div>
            <div className="table-tools">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索币种" aria-label="搜索币种" />
              <button className={onlyExecutable ? "selected" : ""} onClick={() => setOnlyExecutable(!onlyExecutable)}>仅看候选</button>
              <span><Clock3 size={13} />{data ? relativeTime(data.generatedAt) : "—"}</span>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>合约</th><th>双腿路径</th><th>多头费率</th><th>空头费率</th><th>8h 价差</th><th>净 APR</th><th>回本周期</th><th>流动性</th><th>状态</th><th>距结算</th></tr></thead>
              <tbody>{opportunities.map((item) => <OpportunityRow key={`${item.symbol}-${item.longExchange}-${item.shortExchange}`} item={item} />)}</tbody>
            </table>
            {!loading && opportunities.length === 0 && <div className="empty">当前参数下没有匹配机会，请放宽筛选条件。</div>}
            {loading && !data && <div className="empty"><RefreshCw className="spin" size={20} /> 正在连接五个交易所…</div>}
          </div>
        </section>

        <section className="method-grid" id="method">
          <article className="formula-card">
            <span className="section-index">02</span><h3>我们算的不是毛差</h3>
            <div className="formula"><span>净收益</span><b>=</b><strong>资金费率差</strong><b>−</b><i>四腿手续费</i><b>−</b><i>四腿滑点</i><b>+</b><em>基差变化</em></div>
            <p>不同结算周期先统一到 8 小时。1 小时费率不能直接与 8 小时费率比较。</p>
            <button onClick={() => setShowMethod(!showMethod)}>查看计算口径 <ChevronDown size={15} className={showMethod ? "up" : ""} /></button>
            {showMethod && <div className="method-detail">净 APR = (8h 费率差 − 往返成本 ÷ 持有期数) × 1,095。回本期数使用 2× 安全系数；实际结果还会受基差、成交深度、费率路径变化和资金占用影响。</div>}
          </article>
          <article className="sources-card">
            <span>数据源健康</span>
            {(data?.health ?? []).map((item) => <div key={item.exchange}><ExchangeBadge name={item.exchange} /><strong>{item.exchange}</strong><small>{item.ok ? `${item.quoteCount} 对 · ${item.latencyMs}ms` : item.error}</small><i className={item.ok ? "ok" : "down"} /></div>)}
          </article>
        </section>

        <section className="risk-section" id="risk">
          <div><span className="section-index">03</span><h3>先活下来，再谈收益</h3><p>公开版本不接收 API Key、不保存账户数据、不发送订单。真实执行面必须运行在固定出口 IP 主机，并通过子账户、禁止提现、IP 白名单和独立风控进程隔离。</p></div>
          <div className="risk-steps"><span>MARKET DATA</span><b>→</b><span>PAPER</span><b>→</b><span>TESTNET</span><b>→</b><span className="locked">LIVE · LOCKED</span></div>
        </section>
      </main>

      <footer><div className="brand mini"><div className="brand-mark"><span /><span /></div><strong>FUNDARB</strong></div><p>研究工具，不构成投资建议。永续合约、跨平台资产托管、基差与交易所信用均可能造成本金损失。</p><a href="https://github.com/Hans010101/fundarb" target="_blank" rel="noreferrer">GitHub ↗</a></footer>
    </div>
  );
}

export default App;
