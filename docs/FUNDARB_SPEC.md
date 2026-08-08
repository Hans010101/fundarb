# 跨交易所资金费率套利系统 —— 产品与技术规格说明书

| 项 | 内容 |
|---|---|
| 项目代号 | `fundarb` |
| 文档版本 | v1.0 |
| 定位 | 单人自营交易系统（非对外产品） |
| 目标执行方 | Codex / AI 编码代理 |
| 交付形态 | 私有 Git 仓库 + 东京 VPS 自托管 |

> **给开发方的阅读顺序**：先读 §1–§3 建立业务认知（**不要跳过 §3 的收益模型，全系统的正确性都建立在它之上**），再读 §4 架构，然后按 §12 的里程碑顺序逐模块实现。§11 的 FMEA 与 §14 的测试规格是验收依据，实现前必须先读。

---

## 目录

1. 项目概述
2. 术语表
3. 业务模型与核心公式
4. 系统架构
5. 模块详细设计
6. 交易所适配层规格
7. 数据模型
8. 双腿执行状态机
9. 风控规格
10. 配置规格
11. 失败模式与处置（FMEA）
12. 里程碑与交付计划
13. 工程规范
14. 测试规格
15. 部署与 CI/CD
16. 安全规格
17. 附录

---

# 1. 项目概述

## 1.1 一句话定义

一套单人自营的跨交易所资金费率套利执行系统，在可控风险下持续捕获 funding carry，并在极端行情中优先保证**不留裸敞口**。

## 1.2 业务逻辑

同一永续合约在不同交易所的资金费率存在差异。在费率为负（或较低）的交易所 **做多**、在费率为正（或较高）的交易所 **做空**，构建 delta 中性组合，持有期内持续收取两边资金费率之差。当剩余预期收益不足以覆盖平仓成本时，双腿同时平仓退出。

## 1.3 目标（Goals）

| ID | 目标 |
|---|---|
| G1 | 多交易所资金费率归一化扫描与净收益测算 |
| G2 | 双腿准原子化开仓 / 平仓，腿差暴露时长可控 |
| G3 | 独立进程实时风控：净 delta、保证金率、熔断、紧急平仓 |
| G4 | 进程崩溃后状态可恢复、可对账，零重复下单 |
| G5 | PnL 四维归因（费率 / 基差 / 手续费 / 滑点） |
| G6 | 全链路免费数据源，月运营成本 < $45 |

## 1.4 非目标（Non-Goals，明确不做）

| ID | 不做 | 理由 |
|---|---|---|
| N1 | 多用户 / 鉴权 / 权限体系 | 单人自用 |
| N2 | 移动端 App / 精美 UI / 响应式设计 | 只读看板足够 |
| N3 | 亚毫秒级延迟优化 | 策略持仓以天计，秒级足够 |
| N4 | 策略市场 / 可视化参数编辑器 | 配置文件足够 |
| N5 | 除 funding arb 外的任何策略 | 范围控制 |
| N6 | 高可用多活集群 | 单机 + 快速重启 + 可靠对账即可 |
| N7 | 对外 API / SaaS 化接口 | 明确不产品化 |

> **给开发方**：以上 7 条为硬约束。若实现过程中产生"顺便支持一下"的冲动，一律驳回。

## 1.5 核心指标

**北极星指标：净费率捕获率**

```
净捕获率 = 实际到账净收益 / 理论毛费率差收益
目标: > 60%
```

**护栏指标**（任一越界即暂停开新仓）

| 指标 | 阈值 | 采集方式 |
|---|---|---|
| 腿差暴露时长 P95 | < 5 秒 | executor 打点 |
| 腿差失败率（触发回滚的比例） | < 2% | executor 统计 |
| 实盘 vs 回测收益偏差 | < 30% | ledger vs backtest |
| 单日最大回撤 | < 1.5% | ledger |
| 崩溃恢复对账准确率 | 100% | recon |
| 有效杠杆 | ≤ 2.0x | risk |

## 1.6 最终验收标准

系统在 P2 结束时必须逐条满足：

1. 任意时刻 30 秒内可回答：当前净 delta、两边保证金率、最坏情况亏损
2. 强杀进程后重启，本地状态与交易所真实持仓 100% 对齐，零重复下单
3. 手动模拟"单边被强平"，系统 60 秒内平掉另一边并发出 CRITICAL 告警
4. 连续 30 天 paper trading + 小额实盘，1.5 节护栏指标全绿

---

# 2. 术语表

| 术语 | 英文 | 定义 |
|---|---|---|
| 资金费率 | Funding Rate | 永续合约多空双方定期互付的费用比率 |
| 结算周期 | Funding Interval | 资金费率结算间隔，主流为 8h，Hyperliquid 为 1h，部分交易所在极端行情下动态降至 4h/2h/1h |
| 预测费率 | Predicted / Estimated Funding Rate | 下一期即将结算的费率，实时变动 |
| 归一化费率 | Normalized Funding Rate | 统一折算到 8h 基准的费率，用于跨所比较 |
| 双腿 | Two Legs | 多头腿（Long Leg）与空头腿（Short Leg） |
| 难腿 | Hard Leg | 流动性较差、滑点较大的一边，应优先成交 |
| 腿差 | Leg Risk / Leg Gap | 一腿已成交而另一腿未成交，产生裸敞口的状态 |
| 基差 | Basis | 本系统中特指两所同一合约的价差 `P_A − P_B` |
| 净 delta | Net Delta | 双腿名义价值的方向性净敞口 |
| ADL | Auto-Deleveraging | 交易所自动减仓机制，会强制平掉盈利方仓位 |
| 有效杠杆 | Effective Leverage | 名义持仓总额 / 总权益 |
| carry | — | 持仓期内累计的资金费率净收入 |
| 幂等键 | Idempotency Key | 本系统中即 `clientOrderId`，保证下单不重复 |
| 真相源 | Source of Truth | 交易所返回的持仓/订单数据；本地存储仅为缓存 |

---

# 3. 业务模型与核心公式

> ⚠️ **本章是全系统正确性的基础。§5.2 signal 模块与 §14.1 单元测试必须严格实现本章公式，覆盖率要求 100%。**

## 3.1 费率归一化

不同交易所结算周期不同，**必须先归一化才能比较**。这是本系统的第一行业务代码。

```
r_norm_8h = r_raw × (8 / T_interval_hours)

年化率:
APR = r_norm_8h × 3 × 365          # 3 次/天 × 365 天
```

**示例**：Hyperliquid 报 0.01% / 1h，归一化后为 0.08% / 8h，是币安 0.01% / 8h 的 **8 倍**。若不归一化，信号层会得出完全错误的结论。

**实现要求**：
- 周期必须从交易所接口**动态读取**，禁止硬编码为 8h
- 若某所返回的周期字段缺失或异常，该交易对直接列入黑名单并告警，**不得使用默认值**

## 3.2 完整损益公式

设：在交易所 A 做多、交易所 B 做空，名义本金 `Q`（单边），持仓期内经历 `n` 个结算点。

```
净收益率 R_net =
      Σ(k=1..n) [ f_B,k − f_A,k ]              # (1) 费率净收入
    − (c_A_open + c_B_open + c_A_close + c_B_close)   # (2) 手续费
    − (s_A_open + s_B_open + s_A_close + s_B_close)   # (3) 滑点
    + ΔBasis                                    # (4) 基差损益
    − c_funding_capital                         # (5) 资金占用成本

其中:
  f_X,k  = 交易所 X 在第 k 个结算点的资金费率（做空为收入方向为正，做多为支出）
  c_X    = 手续费率（taker 或 maker）
  s_X    = 滑点率
  ΔBasis = (Basis_close − Basis_open) / P̄
  Basis  = P_A − P_B
  P̄      = 期间平均价格
```

### 3.2.1 关于第 (4) 项基差损益 —— 最容易被忽略的一项

**推导**：
```
价格部分损益 = (P_A,close − P_A,open)/P_A,open − (P_B,close − P_B,open)/P_B,open
             ≈ [(P_A,close − P_B,close) − (P_A,open − P_B,open)] / P̄
             = (Basis_close − Basis_open) / P̄
```

**方向判断**：做多 A（低费率端）时，A 的永续通常相对折价，即 `Basis_open < 0`。若基差向 0 收敛，`ΔBasis > 0`，**基差是收益增强项**。

**但风险在于**：极端行情中基差会先剧烈走阔（`ΔBasis` 急剧转负），浮亏触发保证金不足，被迫在最差点位平仓，把浮亏变实亏。

> **给开发方**：`ledger` 模块必须把 `ΔBasis` 单独记账，不得混入总 PnL。这是判断策略是否健康的关键指标。

## 3.3 成本基准

| 项 | 典型值（VIP0） | 备注 |
|---|---|---|
| 单腿 taker 手续费 | 0.045% – 0.055% | 各所不同，需从接口读取 |
| 4 腿往返总手续费 | **0.18% – 0.22%** | 开 2 腿 + 平 2 腿 |
| 单腿滑点（主流币，小额） | 0.01% – 0.03% | 需 P1 实测校准 |
| 往返总成本 | **约 0.22% – 0.34%** | 进场阈值的基准 |

## 3.4 进场条件

```
最小持仓周期数:
  H_min = ceil( C_total × SafetyFactor / r_spread_norm )

进场条件（全部满足）:
  1. r_spread_norm > 0
  2. H_min ≤ max_holding_periods            # 配置项，建议 21（约 7 天）
  3. 预期净 APR > min_entry_apr             # 配置项，建议 12%
  4. 双边盘口深度 ≥ 目标名义 × depth_multiple  # 建议 3.0
  5. 两所该合约均不在黑名单
  6. 当前总有效杠杆 + 新增 ≤ max_leverage
  7. 当日回撤未触及 daily_drawdown_limit

其中:
  C_total      = 4 腿手续费 + 4 腿预估滑点
  SafetyFactor = 2.0（配置项）
```

## 3.5 出场条件（任一满足即平仓）

| 优先级 | 条件 | 说明 |
|---|---|---|
| P0 | 风控 KillSignal | 无条件立即执行，见 §9 |
| P1 | 费率差反转且持续 ≥ `reversal_periods`（建议 2 期） | 防止单次噪声误触发 |
| P2 | 剩余预期 carry < 平仓成本（2 腿） | 核心退出逻辑 |
| P3 | 持仓时长 > `max_holding_days` | 防止僵尸仓位 |
| P4 | 该合约被列入黑名单 / 交易所公告下架 | 提前退出 |

> ⚠️ **禁止**使用"费率差归零即平仓"作为出场条件。频繁进出会被手续费吃光收益。

## 3.6 收益预期基准（用于校验实现是否正确）

| 场景 | 毛费率差 | 净 APR（VIP0） |
|---|---|---|
| 主流币常态 | 0.005% – 0.02% / 8h | 5% – 15% |
| 行业实测均值参考 | — | 约 19%（含高档手续费与规模优势） |

若回测结果显著高于此区间（如 > 50% APR），**几乎可以确定模型漏算了成本项**，应立即排查。

---

# 4. 系统架构

## 4.1 部署拓扑

```
                    ┌────────────────────────────────┐
   GitHub 私有仓 ──▶│ Actions: lint/type/test/chaos  │
                    └──────────┬─────────────────────┘
                               │ 构建镜像 → GHCR
                               ▼
                    ┌────────────────────────────────┐
                    │  东京 VPS（固定 IP，已绑白名单）  │
                    │  ┌──────────┐  ┌─────────────┐ │
                    │  │  engine  │  │ risk(独立)  │ │──▶ 交易所 API
                    │  │ (进程 1) │  │  (进程 2)   │ │
                    │  └────┬─────┘  └─────────────┘ │
                    │       │  SQLite + 快照 JSON     │
                    └───────┼────────────────────────┘
                            │                    ▲
              ┌─────────────┴──────┐             │ Cloudflare Tunnel
              ▼                    ▼             │ （VPS 零入站端口）
       R2（Parquet/备份）    Pages（只读看板）   浏览器 / 手机
                                                 │
                          Telegram Bot ◀─────────┘ 分级告警
```

**关键约束**：
- 引擎必须运行在**固定出口 IP** 的 VPS 上（交易所 API 需绑定 IP 白名单）
- **禁止**将引擎部署到 Cloudflare Workers / Durable Objects 或任何出口 IP 不固定的边缘运行时
- Cloudflare 仅承担三个角色：Tunnel（安全访问）、Pages（只读看板）、R2（数据与备份）

## 4.2 进程模型

| 进程 | 名称 | 职责 | 独立原因 |
|---|---|---|---|
| 1 | `engine` | feed / signal / executor / ledger / recon | 主业务流 |
| 2 | `risk` | 风控监控与紧急平仓 | **必须能越过策略层直接杀仓**；engine 崩溃时仍需存活 |
| 3 | `ui` | Streamlit 只读看板 | 崩溃不影响交易 |

**进程间通信**：
- `engine` → `risk`：共享 SQLite（WAL 模式）+ 本地 Unix socket 心跳
- `risk` → 交易所：**独立的 API 客户端与独立密钥**，不依赖 engine 任何代码路径
- `risk` 每 `risk_poll_interval`（建议 3s）独立向交易所拉取持仓与保证金，**不信任 engine 提供的数据**

> **给开发方**：`risk` 进程必须能在 `engine` 完全崩溃、SQLite 损坏的情况下，仅凭配置文件和交易所 API 完成"查询持仓 → 判断风险 → 全平"的完整闭环。这是最后一道安全网。

## 4.3 模块依赖图

```
        ┌──────┐
        │ feed │◀─── 交易所公开 WS/REST（无需密钥）
        └───┬──┘
            │ MarketEvent
            ▼
        ┌────────┐        ┌──────────┐
        │ signal │◀───────│ storage  │
        └───┬────┘        └────┬─────┘
            │ OpportunitySignal│
            ▼                  │
        ┌──────────┐           │
        │ executor │───────────┤ OrderIntent → 交易所私有 API
        └───┬──────┘           │
            │ Fill/OrderEvent  │
            ▼                  │
        ┌────────┐             │
        │ ledger │─────────────┤
        └────────┘             │
                               │
        ┌────────┐             │
        │ recon  │─────────────┘
        └────────┘

     ┌──────┐  （独立进程，可越权）
     │ risk │──▶ KillSignal ──▶ executor.emergency_flat()
     └──────┘                └─▶ 直连交易所强制平仓（engine 无响应时）
```

## 4.4 技术栈

| 层 | 选型 | 版本 | 备注 |
|---|---|---|---|
| 语言 | Python | 3.12+ | asyncio 事件驱动 |
| 行情/元数据 | ccxt | 最新稳定版 | **仅用于行情与市场元数据归一化** |
| 下单路径 | 各所官方 SDK 或自写 HTTP 签名 | — | 见 §6.1 决策说明 |
| JSON | orjson | — | WS 高频解析 |
| 数值 | `decimal.Decimal` | 标准库 | **禁止用 float 处理任何金额/数量/价格** |
| 分析存储 | DuckDB + Parquet | — | 历史费率、回测 |
| 事务存储 | SQLite（WAL） | 标准库 | 订单、持仓、事件 |
| 看板 | Streamlit | — | 只读 |
| 告警 | Telegram Bot API | — | 分级 |
| 配置 | YAML + pydantic-settings | — | 强类型校验 |
| 密钥 | sops + age | — | 加密存盘 |
| 容器 | Docker + Docker Compose | — | — |
| 测试 | pytest + pytest-asyncio + hypothesis | — | — |
| 静态检查 | ruff + mypy(strict) | — | CI 强制 |

## 4.5 项目目录结构

```
fundarb/
├── pyproject.toml
├── Makefile                      # make test / make chaos / make report / make deploy
├── docker-compose.yml
├── .github/workflows/ci.yml
├── config/
│   ├── config.example.yaml
│   ├── config.yaml               # gitignored
│   └── secrets.enc.yaml          # sops 加密，可入库
├── docs/
│   ├── FUNDARB_SPEC.md           # 本文档
│   ├── FMEA.md
│   └── ADR/                      # 架构决策记录
├── src/fundarb/
│   ├── core/
│   │   ├── models.py             # 领域模型（dataclass/pydantic）
│   │   ├── events.py             # 事件定义
│   │   ├── enums.py              # 状态枚举
│   │   ├── errors.py             # 异常体系与错误分类
│   │   └── time.py               # UTC ms 时间工具
│   ├── adapters/
│   │   ├── base.py               # ExchangeAdapter 抽象基类
│   │   ├── binance.py
│   │   ├── bybit.py
│   │   ├── okx.py
│   │   ├── bitget.py
│   │   ├── hyperliquid.py
│   │   └── registry.py
│   ├── feed/
│   │   ├── manager.py            # 多所 WS 管理、重连、心跳
│   │   └── normalizer.py         # 费率归一化
│   ├── signal/
│   │   ├── model.py              # §3 公式实现（纯函数）
│   │   ├── scanner.py            # 全市场扫描
│   │   └── rules.py              # 进出场规则
│   ├── executor/
│   │   ├── state_machine.py      # §8 状态机
│   │   ├── leg_executor.py       # 单腿下单、切片
│   │   └── coordinator.py        # 双腿协调、回滚
│   ├── risk/
│   │   ├── __main__.py           # 独立进程入口
│   │   ├── monitor.py
│   │   ├── rules.py              # §9 阈值规则
│   │   └── emergency.py          # 紧急平仓（不依赖 engine）
│   ├── ledger/
│   │   ├── attribution.py        # PnL 四维归因
│   │   └── report.py             # 日报
│   ├── recon/
│   │   └── reconciler.py         # 启动/定时对账
│   ├── storage/
│   │   ├── sqlite.py
│   │   ├── duckdb_store.py
│   │   └── schema.sql
│   ├── notify/
│   │   └── telegram.py           # 分级告警
│   └── ui/
│       └── app.py                # Streamlit
├── scripts/
│   ├── fetch_history.py          # P0：历史费率抓取
│   ├── backtest.py               # P0：回测与筛选
│   └── snapshot_to_r2.py         # 快照推送
└── tests/
    ├── unit/
    ├── integration/
    └── chaos/
```

---

# 5. 模块详细设计

## 5.1 feed —— 行情与费率接入

### 职责
- 维护多交易所 WebSocket 长连接
- 订阅：标记价、预测资金费率、结算周期、盘口 Top-N、成交
- 归一化为统一 `MarketEvent` 投递到事件总线
- 断线重连、心跳监控、数据新鲜度检查

### 接口契约

```python
class FeedManager:
    async def start(self, exchanges: list[str], symbols: list[str]) -> None: ...
    async def stop(self) -> None: ...
    def subscribe(self, handler: Callable[[MarketEvent], Awaitable[None]]) -> None: ...
    def health(self) -> dict[str, FeedHealth]: ...

@dataclass(frozen=True)
class MarketEvent:
    exchange: str
    symbol: str                    # 统一符号，如 "BTC/USDT:USDT"
    mark_price: Decimal
    index_price: Decimal | None
    funding_rate_predicted: Decimal      # 原始值，未归一化
    funding_interval_hours: int          # 从接口动态读取，禁止硬编码
    next_funding_time_ms: int
    bid: Decimal
    ask: Decimal
    bid_depth_usd: Decimal               # Top-N 累计名义
    ask_depth_usd: Decimal
    ts_exchange_ms: int                  # 交易所时间戳
    ts_local_ms: int                     # 本地接收时间戳
```

### 关键要求

| # | 要求 |
|---|---|
| F1 | 每条 `MarketEvent` 必须同时携带交易所时间戳与本地时间戳，供延迟监控 |
| F2 | 数据新鲜度：某交易所超过 `staleness_threshold_ms`（建议 5000）无更新 → 标记 STALE → **冻结该所所有开仓** |
| F3 | 重连采用指数退避（1s → 2s → 4s → ... 上限 60s），重连成功后**必须触发一次 REST 全量快照补齐** |
| F4 | WS 全部断开时自动降级为 REST 轮询（间隔 5s），并发出 WARN 告警，**同时禁止开新仓** |
| F5 | 心跳：每 `heartbeat_interval`（建议 20s）检测一次，连续 3 次无数据判定断线 |
| F6 | 本地与交易所时间戳偏差 > `clock_drift_threshold_ms`（建议 1000）→ CRITICAL 告警 + 拒绝下单 |
| F7 | `funding_interval_hours` 字段发生变化时 → WARN 告警 + 重新计算所有相关信号 |

## 5.2 signal —— 信号计算

### 职责
- 实现 §3 全部公式（**纯函数，无 IO，无状态**）
- 全市场扫描，输出机会排序
- 进出场规则判定

### 接口契约

```python
# model.py —— 纯函数，单元测试覆盖率必须 100%
def normalize_funding(rate: Decimal, interval_hours: int) -> Decimal:
    """折算到 8h 基准"""

def to_apr(rate_8h: Decimal) -> Decimal:
    """8h 费率 → 年化"""

def estimate_total_cost(
    fee_long_open: Decimal, fee_long_close: Decimal,
    fee_short_open: Decimal, fee_short_close: Decimal,
    slip_long_open: Decimal, slip_long_close: Decimal,
    slip_short_open: Decimal, slip_short_close: Decimal,
) -> Decimal:
    """4 腿总成本"""

def min_holding_periods(
    spread_8h: Decimal, total_cost: Decimal, safety_factor: Decimal
) -> int:
    """最小持仓周期数"""

def expected_net_apr(
    spread_8h: Decimal, total_cost: Decimal, holding_periods: int
) -> Decimal:
    """扣除成本后的预期年化"""

def basis_pnl(
    basis_open: Decimal, basis_close: Decimal, avg_price: Decimal
) -> Decimal:
    """基差损益率"""

# scanner.py
class Scanner:
    def scan(self, snapshot: MarketSnapshot) -> list[Opportunity]: ...

@dataclass(frozen=True)
class Opportunity:
    symbol: str
    long_exchange: str
    short_exchange: str
    spread_8h: Decimal              # 归一化后的费率差
    expected_net_apr: Decimal
    min_holding_periods: int
    max_notional_usd: Decimal       # 受盘口深度约束
    hard_leg: str                   # 难腿所在交易所
    score: Decimal                  # 排序依据
    computed_at_ms: int
```

### 排序与筛选

```
score = expected_net_apr × liquidity_factor × stability_factor

liquidity_factor  = min(1.0, min(bid_depth, ask_depth) / (target_notional × 3))
stability_factor  = 1 / (1 + 费率差的近 24h 标准差 / 均值)   # 惩罚剧烈波动的机会
```

**筛选顺序**（短路求值，节省算力）：
1. 黑名单过滤
2. 两所均有该合约且状态正常
3. `spread_8h > 0`
4. `expected_net_apr > min_entry_apr`
5. 深度检查
6. 全局风控检查（杠杆、回撤）

## 5.3 executor —— 执行

### 职责
- 双腿开平仓协调
- 状态机驱动（见 §8）
- 切片下单、腿差熔断、回滚

### 接口契约

```python
class Coordinator:
    async def open_position(self, opp: Opportunity, notional_usd: Decimal) -> ArbPosition: ...
    async def close_position(self, position_id: str, reason: CloseReason) -> None: ...
    async def emergency_flat(self, position_id: str | None = None) -> None:
        """风控调用；position_id 为 None 时全平"""
    def get_state(self, position_id: str) -> ArbState: ...
```

### 三条铁律（写成运行时断言，不是注释）

| # | 铁律 | 实现要求 |
|---|---|---|
| E1 | **难腿优先** | 先在流动性差 / 费率极端的一边下单，成交确认后再对冲。`hard_leg` 由 scanner 计算并传入 |
| E2 | **腿差熔断** | 第一腿成交后 `leg_gap_timeout_ms`（建议 5000）内未完成对冲 → **无条件市价回滚第一腿**，记为 `FLAT_WITH_LOSS` |
| E3 | **绝不重发** | 所有下单携带 `clientOrderId` 幂等键；任何超时/网络错误**必须先查询订单状态**再决定动作，禁止直接重发 |

### 切片下单

```
单笔切片名义 = min(
    target_notional / min_slices,
    盘口 Top5 累计名义 × slice_depth_ratio    # 建议 0.2
)
切片间隔 = slice_interval_ms                   # 建议 200
最大切片数 = max_slices                        # 建议 10
```

若切片执行过程中：
- 累计成交 < 目标的 `min_fill_ratio`（建议 0.9）且已达最大切片数 → 按**已成交量**对冲另一腿，剩余部分放弃
- 价格滑出 `max_slippage_bps`（建议 15）→ 停止后续切片

### 幂等键格式

```
clientOrderId = f"fa-{position_id[:8]}-{leg}-{action}-{seq:03d}"
# 示例: fa-a1b2c3d4-L-OPEN-001
# 约束: 长度 ≤ 32（部分交易所限制），仅含 [A-Za-z0-9-]
```

> **给开发方**：`clientOrderId` 必须**持久化到 SQLite 后再发送请求**，顺序不可颠倒。这是崩溃恢复时判断"这单我发过没有"的唯一依据。

## 5.4 risk —— 风控（独立进程）

见 §9 完整规格。

### 接口契约

```python
class RiskMonitor:
    async def run(self) -> None:
        """主循环，每 risk_poll_interval 秒执行一次"""

    async def evaluate(self, snapshot: AccountSnapshot) -> list[RiskAction]: ...

@dataclass(frozen=True)
class RiskAction:
    level: RiskLevel          # INFO / WARN / DANGER / CRITICAL
    action: ActionType        # ALERT / FREEZE_OPEN / REDUCE / FLAT_ALL
    reason: str
    position_ids: list[str]
```

### 独立性要求（重要）

| # | 要求 |
|---|---|
| R1 | 独立进程、独立配置、**独立的交易所 API 密钥**（可为只读+交易，禁提现） |
| R2 | 不依赖 engine 的任何内存状态；持仓数据直接从交易所拉取 |
| R3 | 不依赖 SQLite 写入路径（可读，但判断逻辑不依赖它） |
| R4 | engine 心跳丢失超过 `engine_heartbeat_timeout`（建议 30s）→ 视为 engine 已死 → risk 接管，直接对交易所下平仓单 |
| R5 | risk 自身崩溃 → systemd/docker restart policy 自动重启 + CRITICAL 告警 |

## 5.5 ledger —— 记账与归因

### 四维归因

每个已平仓的 `ArbPosition` 必须输出：

```python
@dataclass(frozen=True)
class PnLAttribution:
    position_id: str
    funding_pnl: Decimal        # (1) 资金费率净收入
    basis_pnl: Decimal          # (4) 基差损益
    fee_pnl: Decimal            # (2) 手续费（负）
    slippage_pnl: Decimal       # (3) 滑点（负）
    total_pnl: Decimal          # 合计
    # 校验
    exchange_reported_pnl: Decimal   # 交易所账单合计
    discrepancy: Decimal             # total_pnl − exchange_reported_pnl
```

**硬性要求**：`abs(discrepancy) / notional < 0.0005`（5bp）。超出即记 `LedgerDiscrepancy` 事件并告警——说明有成本项没被建模。

### 资金费收支采集
- 从各所"资金费流水"接口拉取实际到账/扣除金额
- **不要用预测费率反推**，必须用实际结算金额
- 每期结算后 60s 内完成采集

## 5.6 recon —— 对账

### 触发时机
1. **进程启动时**（阻塞，对账完成前不允许任何下单）
2. 定时（每 `recon_interval`，建议 300s）
3. 任何 `AMBIGUOUS` 错误发生后立即触发

### 对账流程

```
1. 从各交易所拉取: 当前持仓、未完成订单、近 24h 成交记录
2. 从本地 SQLite 拉取: 记录的持仓、订单、成交
3. 逐项比对:
   ├─ 交易所有仓 / 本地无 → 孤儿持仓 → 归档到 orphan 表 + CRITICAL 告警 + 冻结开仓
   ├─ 本地有仓 / 交易所无 → 幽灵记录 → 以交易所为准清除本地 + WARN
   ├─ 数量不一致        → 以交易所为准修正本地 + WARN
   ├─ 本地有未确认订单  → 用 clientOrderId 查询交易所真实状态 → 补齐
   └─ 交易所有本系统前缀(fa-)的挂单 / 本地无 → 撤销 + WARN
4. 重建状态机状态（见 §8 RECOVERING）
5. 输出对账报告，写入 reconciliation_log
```

> **给开发方**：对账是验收标准第 2 条的实现载体。**任何情况下以交易所返回为唯一真相源**，本地数据与之冲突时无条件让位。

## 5.7 notify —— 告警

### 分级

| 级别 | 触发场景 | 通道 | 是否需人工响应 |
|---|---|---|---|
| INFO | 开仓、平仓、日报 | Telegram 普通消息 | 否 |
| WARN | 数据 STALE、重连、对账修正、切片未完成 | Telegram + 标记 | 当日查看 |
| DANGER | 保证金率跌破二级、腿差回滚、费率反转 | Telegram + @ 提及 | 1 小时内 |
| **CRITICAL** | ADL 检测、孤儿持仓、单边强平、engine 心跳丢失、稳定币脱锚 | Telegram + **重复推送 5 次直到确认** | **立即** |

**CRITICAL 必须能把人叫醒。** 建议配合 Telegram 的通知例外设置或第三方呼叫服务。10·11 那类行情中，活下来的团队靠的是自动告警 + 人工介入，不是全自动。

---

# 6. 交易所适配层规格

## 6.1 CCXT 使用范围（重要决策）

| 用途 | 是否用 CCXT | 理由 |
|---|---|---|
| 市场元数据（精度、最小下单量、合约乘数、费率档位） | ✅ 用 | 纯苦力活，无差异化价值 |
| 行情 WS（标记价、盘口） | ✅ 用 | 同上 |
| 历史资金费率 REST | ✅ 用 | 同上 |
| **下单、撤单、查单** | ❌ **不用，自写** | ① 规避 CCXT 与部分交易所的 builder 分成费（约 1bp，×4 腿 = 0.04%，会吃掉两天收益）；② 下单是唯一需要完全掌握错误码语义的路径，抽象层在此处是负资产 |
| 账户、持仓、保证金查询 | ❌ 自写 | 字段语义差异大，需精确控制 |

> **开工第一件事**：核验目标交易所（币安 / Bybit / OKX / Bitget / Hyperliquid）是否在 CCXT 的 builder 计划名单内。若在，严格执行上表的分离策略。

## 6.2 统一适配器接口

```python
class ExchangeAdapter(Protocol):
    name: str

    # --- 元数据 ---
    async def load_markets(self) -> dict[str, MarketInfo]: ...
    async def get_funding_interval(self, symbol: str) -> int: ...
    async def get_fee_rates(self, symbol: str) -> FeeRates: ...

    # --- 行情（公开，无需密钥）---
    async def watch_ticker(self, symbol: str) -> AsyncIterator[MarketEvent]: ...
    async def fetch_funding_rate_history(
        self, symbol: str, since_ms: int, limit: int
    ) -> list[FundingRecord]: ...

    # --- 交易（私有，自写）---
    async def place_order(self, req: OrderRequest) -> OrderResponse: ...
    async def cancel_order(self, symbol: str, client_order_id: str) -> None: ...
    async def query_order(self, symbol: str, client_order_id: str) -> OrderResponse: ...
    async def fetch_positions(self) -> list[PositionInfo]: ...
    async def fetch_balance(self) -> BalanceInfo: ...
    async def fetch_funding_payments(self, since_ms: int) -> list[FundingPayment]: ...

    # --- 能力声明 ---
    def capabilities(self) -> Capabilities: ...
```

```python
@dataclass(frozen=True)
class Capabilities:
    supports_hedge_mode: bool
    supports_unified_margin: bool
    supports_post_only: bool
    supports_reduce_only: bool
    max_client_order_id_len: int
    rate_limit_per_minute: int
    has_testnet: bool
```

## 6.3 交易所差异对照表

> ⚠️ **本表内容必须在开发时逐项核验官方文档，不得直接采信。** 交易所规则变更频繁，本表仅作为"需要关注哪些维度"的检查清单。

| 维度 | 需确认内容 | 影响模块 |
|---|---|---|
| 资金费率结算周期 | 默认周期；是否支持动态调整（币安/OKX/Bybit 在费率触及上下限时会从 8h 逐级降至 4h/2h/1h）；Hyperliquid 为 1h | signal（归一化） |
| 费率上下限 | 多数为 ±0.375%，但各所与各合约不同 | signal |
| 费率计算基数 | 按标记价还是持仓名义；是否含溢价指数 | ledger |
| 结算时间点 | UTC 具体时刻；是否有偏移 | executor（避免在结算瞬间下单） |
| 持仓模式 | 单向 / 双向（hedge mode）；本系统建议**统一用单向模式**降低复杂度 | adapter |
| 保证金模式 | 逐仓 / 全仓 / 统一账户；建议用**全仓 + 独立子账户** | risk |
| 保证金币种 | USDT / USDC / 多币种抵押 | risk（脱锚风险） |
| 精度规则 | 价格 tick、数量 step、最小名义；截断还是四舍五入 | executor |
| 限流规则 | 权重制还是次数制；下单与查询是否分池 | adapter |
| 错误码 | 需建立完整映射表，见 §6.4 | adapter |
| clientOrderId | 最大长度、允许字符集、是否可复用 | executor |
| 测试网 | 是否提供；行为与主网差异 | 测试 |
| ADL 指标 | 是否提供 ADL 排队等级接口 | risk |

## 6.4 错误分类（关键）

所有交易所错误必须映射到三类之一：

| 类别 | 定义 | 处置 |
|---|---|---|
| `RETRIABLE` | 明确未生效：限流、临时不可用、参数校验失败 | 退避重试，最多 `max_retries`（建议 3） |
| `FATAL` | 明确失败且不应重试：余额不足、合约不存在、权限不足、IP 不在白名单 | 立即终止本次操作，走回滚路径，告警 |
| `AMBIGUOUS` | **状态未知**：请求超时、连接中断、5xx、无响应 | 🔴 **绝对禁止重发**。必须走"查询确认"路径：用 `clientOrderId` 查询订单真实状态，确认后再决策 |

> **给开发方**：`AMBIGUOUS` 的处理是整个系统最容易出致命 bug 的地方。一次错误的重发 = 双倍仓位 = 裸敞口。请为此单独编写测试用例（见 §14.3）。

```python
class ExchangeError(Exception):
    category: ErrorCategory      # RETRIABLE / FATAL / AMBIGUOUS
    exchange: str
    raw_code: str | int
    raw_message: str
```

每个 adapter 必须实现 `classify_error(raw) -> ErrorCategory`，并附带该交易所的完整错误码映射表（写在 adapter 文件顶部的常量字典中，附官方文档链接）。

---

# 7. 数据模型

## 7.1 SQLite Schema

```sql
-- 套利头寸（一个 position = 一对双腿）
CREATE TABLE arb_positions (
    position_id       TEXT PRIMARY KEY,          -- uuid4
    symbol            TEXT NOT NULL,
    long_exchange     TEXT NOT NULL,
    short_exchange    TEXT NOT NULL,
    state             TEXT NOT NULL,             -- 见 §8 状态枚举
    target_notional   TEXT NOT NULL,             -- Decimal 存为 TEXT
    filled_notional_long   TEXT NOT NULL DEFAULT '0',
    filled_notional_short  TEXT NOT NULL DEFAULT '0',
    entry_price_long  TEXT,
    entry_price_short TEXT,
    exit_price_long   TEXT,
    exit_price_short  TEXT,
    basis_open        TEXT,
    basis_close       TEXT,
    spread_at_entry   TEXT,                      -- 归一化 8h 费率差
    expected_apr      TEXT,
    hard_leg          TEXT NOT NULL,             -- 'long' | 'short'
    open_reason       TEXT,
    close_reason      TEXT,
    created_at_ms     INTEGER NOT NULL,
    hedged_at_ms      INTEGER,
    closed_at_ms      INTEGER,
    updated_at_ms     INTEGER NOT NULL
);
CREATE INDEX idx_arb_state ON arb_positions(state);
CREATE INDEX idx_arb_symbol ON arb_positions(symbol, created_at_ms);

-- 订单（先写库、再发送）
CREATE TABLE orders (
    client_order_id   TEXT PRIMARY KEY,
    position_id       TEXT NOT NULL,
    exchange          TEXT NOT NULL,
    symbol            TEXT NOT NULL,
    leg               TEXT NOT NULL,             -- 'long' | 'short'
    action            TEXT NOT NULL,             -- 'OPEN' | 'CLOSE' | 'ROLLBACK'
    side              TEXT NOT NULL,             -- 'buy' | 'sell'
    order_type        TEXT NOT NULL,             -- 'market' | 'limit'
    price             TEXT,
    quantity          TEXT NOT NULL,
    reduce_only       INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL,             -- PENDING_SEND/SENT/PARTIAL/FILLED/CANCELED/REJECTED/UNKNOWN
    exchange_order_id TEXT,
    filled_qty        TEXT NOT NULL DEFAULT '0',
    avg_fill_price    TEXT,
    fee               TEXT,
    fee_currency      TEXT,
    error_category    TEXT,
    error_message     TEXT,
    created_at_ms     INTEGER NOT NULL,
    sent_at_ms        INTEGER,
    finalized_at_ms   INTEGER,
    FOREIGN KEY (position_id) REFERENCES arb_positions(position_id)
);
CREATE INDEX idx_orders_position ON orders(position_id);
CREATE INDEX idx_orders_status ON orders(status);

-- 成交明细
CREATE TABLE fills (
    fill_id           TEXT PRIMARY KEY,          -- exchange + trade_id
    client_order_id   TEXT NOT NULL,
    exchange          TEXT NOT NULL,
    symbol            TEXT NOT NULL,
    side              TEXT NOT NULL,
    price             TEXT NOT NULL,
    quantity          TEXT NOT NULL,
    fee               TEXT NOT NULL,
    fee_currency      TEXT NOT NULL,
    is_maker          INTEGER NOT NULL,
    ts_ms             INTEGER NOT NULL,
    FOREIGN KEY (client_order_id) REFERENCES orders(client_order_id)
);

-- 资金费实际收支（来自交易所账单，非预测值）
CREATE TABLE funding_payments (
    payment_id        TEXT PRIMARY KEY,
    position_id       TEXT,
    exchange          TEXT NOT NULL,
    symbol            TEXT NOT NULL,
    amount            TEXT NOT NULL,             -- 正为收入，负为支出
    currency          TEXT NOT NULL,
    funding_rate      TEXT,
    ts_ms             INTEGER NOT NULL
);
CREATE INDEX idx_funding_position ON funding_payments(position_id);

-- PnL 归因
CREATE TABLE pnl_attribution (
    position_id       TEXT PRIMARY KEY,
    funding_pnl       TEXT NOT NULL,
    basis_pnl         TEXT NOT NULL,
    fee_pnl           TEXT NOT NULL,
    slippage_pnl      TEXT NOT NULL,
    total_pnl         TEXT NOT NULL,
    exchange_reported_pnl TEXT,
    discrepancy       TEXT,
    computed_at_ms    INTEGER NOT NULL
);

-- 风控事件
CREATE TABLE risk_events (
    event_id          TEXT PRIMARY KEY,
    level             TEXT NOT NULL,
    action            TEXT NOT NULL,
    reason            TEXT NOT NULL,
    position_ids      TEXT,                      -- JSON array
    snapshot          TEXT,                      -- JSON，事发时的账户快照
    ts_ms             INTEGER NOT NULL
);

-- 对账日志
CREATE TABLE reconciliation_log (
    recon_id          TEXT PRIMARY KEY,
    trigger           TEXT NOT NULL,             -- STARTUP / SCHEDULED / AMBIGUOUS_ERROR
    discrepancies     TEXT NOT NULL,             -- JSON
    actions_taken     TEXT NOT NULL,             -- JSON
    passed            INTEGER NOT NULL,
    ts_ms             INTEGER NOT NULL
);

-- 孤儿持仓（交易所有、本地无）
CREATE TABLE orphan_positions (
    orphan_id         TEXT PRIMARY KEY,
    exchange          TEXT NOT NULL,
    symbol            TEXT NOT NULL,
    side              TEXT NOT NULL,
    quantity          TEXT NOT NULL,
    entry_price       TEXT,
    discovered_at_ms  INTEGER NOT NULL,
    resolved_at_ms    INTEGER,
    resolution        TEXT
);

-- 系统事件（心跳、启停、配置变更）
CREATE TABLE system_events (
    event_id          TEXT PRIMARY KEY,
    kind              TEXT NOT NULL,
    payload           TEXT,
    ts_ms             INTEGER NOT NULL
);
```

### 存储约定

| 约定 | 说明 |
|---|---|
| 所有金额/数量/价格 | 存为 `TEXT`，代码中用 `Decimal` 读写。**禁止 REAL/FLOAT** |
| 所有时间 | UTC 毫秒时间戳 `INTEGER`。**禁止本地时区、禁止字符串日期** |
| SQLite 模式 | WAL，`synchronous=FULL`（交易系统优先正确性） |
| 写入顺序 | **先写库，后发请求**。任何外部副作用之前必须先持久化意图 |

## 7.2 Parquet Schema（历史费率，DuckDB 分析）

```
funding_history/
  exchange=binance/symbol=BTC-USDT/year=2025/data.parquet

字段:
  exchange           string
  symbol             string       # 统一符号
  funding_rate       decimal(20,10)
  funding_interval_h int32
  funding_rate_8h    decimal(20,10)   # 归一化后
  funding_time_ms    int64
  mark_price         decimal(20,10)
```

---

# 8. 双腿执行状态机

## 8.1 状态定义

| 状态 | 含义 | 是否持有敞口 |
|---|---|---|
| `IDLE` | 无仓位 | 否 |
| `LEG1_PENDING` | 难腿订单已发送，等待成交 | 否（未成交） |
| `LEG1_FILLED` | 难腿已成交 | 🔴 **是（裸敞口）** |
| `LEG2_PENDING` | 对冲腿订单已发送 | 🔴 **是（裸敞口）** |
| `HEDGED` | 双腿已对冲，正常持仓中 | 否（中性） |
| `TOP_UP` | 检测到数量不匹配，正在补齐 | 🟡 部分 |
| `CLOSING` | 正常平仓中 | 递减 |
| `ROLLBACK` | 腿差超时，正在回滚难腿 | 🔴 是 |
| `EMERGENCY_FLAT` | 风控触发的紧急全平 | 🔴 是 |
| `RECOVERING` | 重启后对账中 | 未知 |
| `FLAT` | 已平仓，正常结束 | 否 |
| `FLAT_WITH_LOSS` | 回滚结束，认亏 | 否 |
| `FAILED` | 异常终止，需人工介入 | 🔴 **未知，必须人工** |

## 8.2 状态转移表

| # | From | 事件 | To | 动作 |
|---|---|---|---|---|
| 1 | `IDLE` | 信号确认 + 风控放行 | `LEG1_PENDING` | 写库 → 发送难腿订单 |
| 2 | `LEG1_PENDING` | 完全成交 | `LEG1_FILLED` | 启动腿差计时器 |
| 3 | `LEG1_PENDING` | 部分成交 + 超时 | `LEG1_FILLED` | 撤剩余，按已成交量调整目标 |
| 4 | `LEG1_PENDING` | 未成交 + 超时 | `IDLE` | 撤单，本次机会放弃 |
| 5 | `LEG1_PENDING` | FATAL 错误 | `IDLE` | 撤单，告警 |
| 6 | `LEG1_FILLED` | — | `LEG2_PENDING` | 立即发送对冲腿（市价） |
| 7 | `LEG2_PENDING` | 完全成交 | `HEDGED` | 停止计时器，记录 basis_open |
| 8 | `LEG2_PENDING` | 部分成交 | `TOP_UP` | 补发剩余 |
| 9 | `LEG2_PENDING` | 腿差超时 / FATAL | `ROLLBACK` | 🔴 撤对冲腿 → 市价平难腿 |
| 10 | `TOP_UP` | 补齐成功 | `HEDGED` | — |
| 11 | `TOP_UP` | 补齐失败 + 超时 | `ROLLBACK` | 全部回滚 |
| 12 | `ROLLBACK` | 难腿已平 | `FLAT_WITH_LOSS` | 记账，WARN 告警 |
| 13 | `ROLLBACK` | 回滚失败 | `FAILED` | 🔴 CRITICAL 告警，人工介入 |
| 14 | `HEDGED` | 出场条件满足（§3.5） | `CLOSING` | 双腿同时发平仓单（reduce_only） |
| 15 | `HEDGED` | 风控 KillSignal | `EMERGENCY_FLAT` | 立即市价双平 |
| 16 | `HEDGED` | 检测到一腿持仓消失（ADL/强平） | `EMERGENCY_FLAT` | 🔴 立即平另一腿 + CRITICAL |
| 17 | `CLOSING` | 双腿均平完 | `FLAT` | 记录 basis_close，触发归因 |
| 18 | `CLOSING` | 一腿平完另一腿失败 | `EMERGENCY_FLAT` | 重试 → 失败则 `FAILED` |
| 19 | `EMERGENCY_FLAT` | 双腿均已平 | `FLAT` | 记账，告警 |
| 20 | `EMERGENCY_FLAT` | 平仓失败 | `FAILED` | 🔴 CRITICAL，人工 |
| 21 | 任意 | 进程重启 | `RECOVERING` | 阻塞对账 |
| 22 | `RECOVERING` | 对账完成 | 重建为实际状态 | 见 §8.3 |

## 8.3 RECOVERING 状态的重建规则

进程启动时，对每个非终态的 `arb_position` 执行：

```
1. 查询两个交易所的真实持仓与订单状态
2. 按下表重建:

   交易所实际状态                              → 重建为
   ─────────────────────────────────────────────────────
   两腿均无持仓，无挂单                        → FLAT（补记账）
   两腿均有持仓且数量匹配（±tolerance）        → HEDGED
   仅一腿有持仓                                → EMERGENCY_FLAT（立即平掉）
   两腿有持仓但数量不匹配                      → TOP_UP
   有本系统前缀(fa-)的未完成挂单               → 先撤单，再按持仓判定
   本地有 PENDING_SEND 订单但交易所查无此单    → 标记为 NOT_SENT，安全
   本地有 SENT 订单但交易所查无此单            → 查询 24h 成交记录二次确认
   ─────────────────────────────────────────────────────

3. 任何无法明确判定的情况 → FAILED + CRITICAL 告警 + 冻结所有开仓
```

> **给开发方**：`RECOVERING` 完成前，`executor` 必须拒绝一切下单请求。用一个全局 `system_ready: asyncio.Event` 控制。

## 8.4 腿差计时器

```
计时开始: LEG1 首次成交回报到达
计时结束: LEG2 完全成交，或触发回滚
超时阈值: leg_gap_timeout_ms（默认 5000）

超时后动作（严格顺序，不可并行）:
  1. 撤销 LEG2 所有未成交挂单
  2. 查询 LEG2 实际成交量 X
  3. 若 X > 0: 只回滚 LEG1 中超出 X 的部分，剩余 min(LEG1, X) 保持为 HEDGED
  4. 若 X == 0: 全量市价平掉 LEG1
  5. 记录 FLAT_WITH_LOSS，统计到腿差失败率
```

**指标要求**：腿差暴露时长 P95 < 5s，腿差失败率 < 2%。

---

# 9. 风控规格

## 9.1 分级阈值表

`risk` 进程每 `risk_poll_interval`（默认 3s）对每个交易所独立评估。

### 保证金率（`margin_ratio = 账户权益 / 维持保证金`）

| 级别 | 阈值 | 动作 |
|---|---|---|
| 正常 | ≥ 400% | — |
| INFO | 300% – 400% | 记录 |
| WARN | 200% – 300% | 告警 + **冻结开新仓** |
| DANGER | 150% – 200% | 自动减仓 30%（**双腿等比例**）+ DANGER 告警 |
| CRITICAL | < 150% | 🔴 **全平所有仓位** + CRITICAL 告警 |

> **关键**：减仓必须**双腿等比例**执行，否则减仓动作本身会制造裸敞口。

### 净 delta

```
net_delta_usd = Σ(long_notional) − Σ(short_notional)
net_delta_ratio = |net_delta_usd| / total_notional
```

| 条件 | 动作 |
|---|---|
| `net_delta_ratio > 0.01` 且持续 > 5s | DANGER 告警 + 强制对冲 |
| `net_delta_ratio > 0.05` | 🔴 CRITICAL + 全平 |
| 状态为 `LEG1_FILLED`/`LEG2_PENDING` 期间 | 豁免（由腿差计时器管辖），但超时后不豁免 |

### 有效杠杆

```
effective_leverage = Σ(单边名义持仓) / 总权益
```

| 阈值 | 动作 |
|---|---|
| > 2.0 | 冻结开新仓 |
| > 2.5 | DANGER + 减仓至 2.0 |
| > 3.0 | 🔴 CRITICAL + 全平 |

### 回撤

| 条件 | 动作 |
|---|---|
| 当日回撤 > 1.0% | WARN + 冻结开新仓 |
| 当日回撤 > 1.5% | DANGER + 平掉盈利最差的 50% 仓位 |
| 当日回撤 > 2.5% | 🔴 CRITICAL + 全平 + 停机（需人工重启） |

### 特殊监控

| 监控项 | 触发条件 | 动作 |
|---|---|---|
| **ADL 检测** | 某腿持仓量在无本系统订单的情况下减少 | 🔴 CRITICAL + 立即平另一腿 |
| **单边强平** | 某腿持仓归零且非本系统平仓 | 🔴 CRITICAL + 立即平另一腿 |
| **稳定币脱锚** | 保证金币种（USDT/USDC/USDe 等）价格偏离 1.0 超过 1% | 🔴 CRITICAL + 全平 |
| **engine 心跳丢失** | 超过 30s 无心跳 | risk 接管，直接对交易所下平仓单 |
| **时钟漂移** | 与交易所时间偏差 > 1000ms | 拒绝下单 + CRITICAL |
| **数据 STALE** | 某所 > 5s 无行情 | 冻结该所开仓 |
| **交易所错误率** | 1 分钟内错误率 > 20% | 熔断该所 + DANGER |

## 9.2 三级处置的执行顺序

```
FREEZE_OPEN  → 仅停止开新仓，已有仓位不动
REDUCE       → 按比例双腿等量减仓，市价 reduce_only
FLAT_ALL     → 全部仓位双腿市价平掉，reduce_only，不计成本
```

`FLAT_ALL` 的实现要求：
1. 并发对所有仓位、所有腿发送市价 reduce_only 单
2. 单腿失败不阻塞其他腿
3. 全部完成后拉取持仓验证，未清零的重试最多 5 次
4. 5 次后仍未清零 → `FAILED` + CRITICAL 持续告警

## 9.3 熔断开关

提供一个**文件级人工熔断**：

```
若 /var/run/fundarb/HALT 文件存在:
  → engine 立即停止开新仓
  → risk 执行 FLAT_ALL
  → 两个进程保持运行但拒绝任何开仓
```

这是最后的人工干预手段，必须能在 SSH 上一条 `touch` 命令生效。

---

# 10. 配置规格

## 10.1 config.yaml

```yaml
system:
  mode: paper                      # paper | live
  timezone: UTC                    # 固定，不可改
  halt_file: /var/run/fundarb/HALT
  system_ready_timeout_s: 120      # 启动对账超时

exchanges:
  - name: binance
    enabled: true
    testnet: false
    account_type: futures_usdt
    position_mode: one_way         # 统一用单向模式
    margin_mode: cross
    subaccount: fundarb-01
  - name: bybit
    enabled: true
    testnet: false
    account_type: unified
    position_mode: one_way
    margin_mode: cross
  - name: okx
    enabled: false
  - name: bitget
    enabled: false
  - name: hyperliquid
    enabled: false

universe:
  whitelist:                       # 只交易白名单内合约
    - BTC/USDT:USDT
    - ETH/USDT:USDT
    - SOL/USDT:USDT
  blacklist: []                    # 运行时动态加入
  min_24h_volume_usd: 50000000

signal:
  min_entry_apr: 0.12              # 12% 年化
  safety_factor: 2.0
  max_holding_periods: 21          # 约 7 天
  max_holding_days: 14
  reversal_periods: 2              # 费率反转持续几期才退出
  depth_multiple: 3.0
  scan_interval_s: 10
  stability_lookback_h: 24

execution:
  target_notional_usd: 2000        # 单个仓位名义
  max_concurrent_positions: 3
  leg_gap_timeout_ms: 5000
  min_slices: 3
  max_slices: 10
  slice_interval_ms: 200
  slice_depth_ratio: 0.2
  max_slippage_bps: 15
  min_fill_ratio: 0.9
  avoid_funding_window_s: 60       # 结算前后 60s 不下单
  hard_order_notional_cap_usd: 5000   # 代码级硬上限，不从配置读的备份常量见 §13

risk:
  poll_interval_s: 3
  engine_heartbeat_timeout_s: 30
  margin_ratio:
    warn: 3.0
    danger: 2.0
    critical: 1.5
  max_effective_leverage: 2.0
  net_delta_ratio_warn: 0.01
  net_delta_ratio_critical: 0.05
  daily_drawdown_warn: 0.010
  daily_drawdown_danger: 0.015
  daily_drawdown_critical: 0.025
  stablecoin_depeg_threshold: 0.01
  daily_notional_cap_usd: 50000    # 单日累计下单额上限

feed:
  staleness_threshold_ms: 5000
  heartbeat_interval_s: 20
  clock_drift_threshold_ms: 1000
  reconnect_max_backoff_s: 60

recon:
  interval_s: 300
  quantity_tolerance: 0.001        # 0.1% 数量容差

ledger:
  discrepancy_threshold_bps: 5
  daily_report_utc_hour: 0

notify:
  telegram:
    enabled: true
    critical_repeat: 5
    critical_repeat_interval_s: 60

storage:
  sqlite_path: /data/fundarb.db
  parquet_dir: /data/funding_history
  r2_bucket: fundarb-data
  snapshot_interval_s: 60
```

## 10.2 配置校验要求

启动时用 pydantic 强类型校验，以下情况**拒绝启动**：
- 任何 Decimal 字段无法解析
- `mode: live` 但密钥文件缺失或解密失败
- 阈值逻辑矛盾（如 `warn < danger`）
- 白名单为空
- `target_notional_usd × max_concurrent_positions` 超过 `daily_notional_cap_usd`

## 10.3 密钥文件（sops 加密）

```yaml
# secrets.enc.yaml（加密后可入库）
binance:
  engine:
    api_key: ...
    api_secret: ...
  risk:                            # risk 进程独立密钥
    api_key: ...
    api_secret: ...
bybit:
  engine: {...}
  risk: {...}
telegram:
  bot_token: ...
  chat_id: ...
cloudflare:
  r2_access_key: ...
  r2_secret_key: ...
```

---

# 11. 失败模式与处置（FMEA）

> 本表是**必须实现的需求清单**，不是参考资料。每一行都应有对应的代码路径和测试用例。

| # | 失败模式 | 触发条件 | 后果 | 探测手段 | 处置 | 测试用例 |
|---|---|---|---|---|---|---|
| 1 | 单腿成交、另一腿被拒 | LEG2 返回 FATAL | 裸敞口 | 订单状态回报 | 5s 内市价回滚 LEG1 | `test_leg2_rejected_rollback` |
| 2 | 部分成交 | 流动性不足 | 敞口不匹配 | 成交量比对 | 按已成交量补对冲，超时则回滚差额 | `test_partial_fill_topup` |
| 3 | **下单请求超时（AMBIGUOUS）** | 网络/5xx | 🔴 状态未知，重发会双倍开仓 | 异常分类 | **禁止重发**；用 clientOrderId 查询真实状态后决策 | `test_ambiguous_no_resend` |
| 4 | WS 断线 | 网络波动 | 状态失真 | 心跳超时 | 切 REST 轮询 + 冻结开仓 + 重连后 REST 补齐 | `test_ws_disconnect_degrade` |
| 5 | 进程崩溃重启 | OOM/部署/panic | 状态丢失、可能重复下单 | 启动 recon | 以交易所为真相源重建状态 | `test_crash_recovery` |
| 6 | 单边保证金不足 | 单边浮亏扩大 | 强平 | margin_ratio 轮询 | 三级：冻结 → 减仓 30% → 全平 | `test_margin_ladder` |
| 7 | **ADL 自动减仓** | 极端行情 | 盈利腿被砍，剩裸单 | 持仓量无订单变化 | 立即平另一腿 + CRITICAL 唤醒 | `test_adl_detection` |
| 8 | 费率反转 | 市场情绪切换 | carry 变负 | 每期结算后重算 | 持续 2 期则平仓 | `test_funding_reversal` |
| 9 | 交易所限流 | 请求过密 | 下单失败 | 429 / 权重头 | 令牌桶限流 + 退避；下单与查询分池 | `test_rate_limit_backoff` |
| 10 | 交易所宕机 | 系统故障 | 无法平仓 | 错误率 > 20% | 熔断该所 + 唤醒人工 | `test_exchange_outage` |
| 11 | 时钟漂移 | NTP 失效 | 签名失败/时序错乱 | 交易所时间对比 | 拒绝下单 + CRITICAL | `test_clock_drift` |
| 12 | 结算周期被调整 | 交易所动态降频 | 收益模型算错 | interval 字段变更监控 | 告警 + 重算 + 必要时平仓 | `test_interval_change` |
| 13 | 合约下架/迁移 | 交易所公告 | 强制平仓 | 白名单人工维护 + 合约状态检查 | 提前退出 | `test_symbol_delisted` |
| 14 | **稳定币脱锚** | 极端行情 | 保证金价值失真 | 保证金币种价格监控 | 全平 + 唤醒 | `test_stablecoin_depeg` |
| 15 | 孤儿持仓 | 对账发现交易所有仓本地无 | 未受管理的敞口 | recon | 归档 + CRITICAL + 冻结开仓 | `test_orphan_position` |
| 16 | 幽灵记录 | 本地有仓交易所无 | 状态误判 | recon | 以交易所为准清除 | `test_ghost_position` |
| 17 | 重复平仓 | 回报延迟导致重发 | 反向开仓 | 幂等键 + reduce_only | 平仓单**必须** reduce_only；下单前查持仓 | `test_no_double_close` |
| 18 | 精度截断错误 | 数量/价格未按 step 对齐 | 下单被拒或数量偏差 | 下单前校验 | 统一用交易所 step 向下取整 | `test_precision_rounding` |
| 19 | 结算瞬间下单 | 时机不当 | 意外承担/错失一期费率 | 结算时间窗检查 | 结算前后 60s 禁止开平仓 | `test_funding_window_block` |
| 20 | engine 心跳丢失 | engine 崩溃/卡死 | 仓位无人管理 | risk 独立心跳检测 | risk 接管平仓 | `test_risk_takeover` |

---

# 12. 里程碑与交付计划

## 12.1 阶段划分

| 阶段 | 内容 | 人日 | 出口判据 | 闸门 |
|---|---|---|---|---|
| **P-1** | 情报：通读开源缺陷清单 + 5 所 API 文档，补全 FMEA | 2 | FMEA ≥ 40 条 | — |
| **P0** | 历史费率抓取 + 回测模型 + 全市场筛选报告 | 4 | 净 APR > 12% 的组合 ≥ 5 个 | 🔴 **人工 go/no-go** |
| **P1** | 最小双腿执行器，2000 USDT 实盘采样 4 周 | 3 + 4 周等待 | 腿差率 < 2%，实盘 ≥ 回测 70% | 🔴 **人工 go/no-go** |
| **P2** | 完整引擎，6 个模块分 6 次 PR 交付 | 20–25 | §1.6 验收标准 4 条全过 | — |
| **P3** | 加固：ADL 探测、混沌测试常态化、多所扩展 | 持续 | — | — |

**总计约 30–35 人日开发 + 4 周实盘等待期。**

## 12.2 P2 模块交付顺序（不可调换）

| 序 | 模块 | 依赖 | 交付物 |
|---|---|---|---|
| 1 | `core` + `storage` + `risk` | 无 | 领域模型、DDL、风控进程（可空跑） |
| 2 | `adapters` + `feed` | 1 | 至少 binance + bybit，含错误码映射表 |
| 3 | `executor` | 2 | 状态机 + 混沌测试 |
| 4 | `signal` | 2 | §3 公式，单测 100% |
| 5 | `ledger` + `recon` | 3 | 四维归因 + 对账 |
| 6 | `ui` + `notify` | 全部 | Streamlit + Telegram |

> **为什么 risk 排第一**：风控是唯一不能事后补的模块。先有安全网，再有策略。

## 12.3 每个 PR 的交付要求

1. 代码 + 单元测试（新增代码覆盖率 ≥ 85%，`signal/model.py` 必须 100%）
2. `executor` 模块额外附混沌测试
3. `docs/ADR/` 中记录本次的关键决策
4. CI 全绿（ruff + mypy strict + pytest）
5. README 中该模块的运行说明

---

# 13. 工程规范

> **以下为对 Codex / AI 编码代理的硬性约束，违反任意一条即视为交付不合格。**

## 13.1 数值与时间

| # | 规则 |
|---|---|
| C1 | **禁止用 `float` 处理任何金额、数量、价格、费率。** 一律 `decimal.Decimal`，从字符串构造 |
| C2 | 所有时间统一 UTC 毫秒整数。禁止 `datetime.now()`（无时区），禁止本地时区，禁止字符串日期 |
| C3 | 精度处理统一向下取整（`ROUND_DOWN`）到交易所 step，避免超出余额 |
| C4 | 比较 Decimal 相等时使用容差，不用 `==` |

## 13.2 错误处理

| # | 规则 |
|---|---|
| C5 | **禁止裸 `except:` 和 `except Exception: pass`。** 每个 except 必须明确类型并有处理逻辑 |
| C6 | 所有交易所异常必须映射到 `RETRIABLE / FATAL / AMBIGUOUS` 三类之一，未映射的错误码默认归入 `AMBIGUOUS`（最保守） |
| C7 | `AMBIGUOUS` 路径**禁止任何形式的重发**，必须走查询确认 |
| C8 | 日志必须结构化（JSON），含 `position_id`、`client_order_id`、`exchange`、`state` |

## 13.3 副作用顺序

| # | 规则 |
|---|---|
| C9 | **先持久化意图，后产生外部副作用。** 下单前必须先写入 `orders` 表（status=PENDING_SEND） |
| C10 | 所有平仓单必须带 `reduce_only=True` |
| C11 | 所有下单必须带 `clientOrderId`，格式见 §5.3 |
| C12 | 下单前必须校验：白名单、精度、名义上限、结算时间窗、系统就绪状态 |

## 13.4 硬上限（代码级常量，不从配置读）

在 `core/constants.py` 中定义，作为配置被误改时的最后防线：

```python
ABSOLUTE_MAX_ORDER_NOTIONAL_USD = Decimal("10000")
ABSOLUTE_MAX_LEVERAGE = Decimal("3.0")
ABSOLUTE_MAX_CONCURRENT_POSITIONS = 5
ABSOLUTE_MAX_DAILY_NOTIONAL_USD = Decimal("100000")
```

任何请求超出上述常量 → 直接 raise + CRITICAL 告警，**不允许通过配置绕过**。

## 13.5 并发

| # | 规则 |
|---|---|
| C13 | 单进程 asyncio，禁止多线程共享可变状态 |
| C14 | 每个 `position_id` 的状态转移必须串行（用 per-position `asyncio.Lock`） |
| C15 | 交易所 API 调用统一走令牌桶限流器，下单与查询分池 |
| C16 | 所有 `asyncio.Task` 必须持有引用并在退出时 cancel，禁止 fire-and-forget |

## 13.6 禁止事项

- ❌ 禁止在代码中硬编码 API 密钥、交易所 URL 之外的任何账户信息
- ❌ 禁止硬编码 `funding_interval = 8`
- ❌ 禁止在生产路径使用 `print()`
- ❌ 禁止引入 §1.4 非目标范围内的功能
- ❌ 禁止为了通过测试而放宽断言

---

# 14. 测试规格

## 14.1 单元测试

| 目标 | 覆盖率要求 |
|---|---|
| `signal/model.py`（§3 全部公式） | **100%** |
| `feed/normalizer.py` | **100%** |
| `core/` 领域模型与精度工具 | **100%** |
| 其他新增代码 | ≥ 85% |

**必测用例（示例）**：

```python
# 归一化
assert normalize_funding(Decimal("0.0001"), 1) == Decimal("0.0008")   # HL 1h → 8h
assert normalize_funding(Decimal("0.0001"), 8) == Decimal("0.0001")
assert normalize_funding(Decimal("0.0001"), 4) == Decimal("0.0002")

# 成本与最小周期
# spread=0.01%/8h, 总成本=0.25%, safety=2.0 → H_min = ceil(0.005/0.0001) = 50
# 超过 max_holding_periods(21) → 不应进场

# 基差损益方向
# 做多A做空B，basis_open=-10, basis_close=0, P̄=100 → basis_pnl = +0.1
assert basis_pnl(Decimal("-10"), Decimal("0"), Decimal("100")) == Decimal("0.1")

# 精度截断
# step=0.001, qty=1.2349 → 1.234（向下）
```

**属性测试**（hypothesis）：
- 对任意 interval ∈ {1,2,4,8}，`normalize_funding` 后再反归一化应还原
- `expected_net_apr` 对成本单调递减

## 14.2 集成测试

| 用例 | 环境 | 验证点 |
|---|---|---|
| 完整开平仓闭环 | 交易所测试网 | 状态机走完 IDLE → HEDGED → FLAT |
| 限流触发与恢复 | 测试网 | 令牌桶生效，无 429 泄漏 |
| 精度与最小名义 | 测试网 | 边界数量下单成功 |
| 资金费实际到账采集 | 主网小额 | funding_payments 与账单一致 |
| 归因与账单核对 | 主网小额 | `discrepancy < 5bp` |

## 14.3 混沌测试（必须实现，`make chaos`）

> 90% 的真实损失来自异常路径，而异常路径只能靠主动注入才能测到。

| 用例 | 注入方式 | 期望行为 |
|---|---|---|
| `test_crash_recovery` | LEG1 成交后 `SIGKILL` engine | 重启后 recon 识别单腿持仓 → EMERGENCY_FLAT |
| `test_ambiguous_no_resend` | mock 下单接口返回超时 | **不重发**，走查询路径 |
| `test_leg2_rejected_rollback` | mock LEG2 返回 FATAL | 5s 内 LEG1 被市价平掉 |
| `test_partial_fill_topup` | mock 部分成交 | 按已成交量补齐或回滚差额 |
| `test_ws_disconnect_degrade` | iptables 断 WS 端口 | 降级 REST + 冻结开仓 + 重连补齐 |
| `test_adl_detection` | mock 持仓量凭空减少 | 立即平另一腿 + CRITICAL |
| `test_risk_takeover` | `SIGSTOP` engine 进程 | risk 在 30s 后接管并平仓 |
| `test_no_double_close` | mock 平仓回报延迟 + 重复触发 | 幂等键生效，无二次下单 |
| `test_clock_drift` | mock 交易所时间偏移 2s | 拒绝下单 + CRITICAL |
| `test_halt_file` | `touch HALT` | 立即冻结 + FLAT_ALL |

**混沌测试必须纳入 CI，每次 PR 全量跑。**

## 14.4 回测验证

`scripts/backtest.py` 必须支持：
- 指定时间区间、交易所组合、交易对
- 参数敏感性分析：手续费档位 × 持仓周期 × safety_factor
- 输出：净 APR 排序表、最大回撤、持仓次数、平均持仓时长
- **一条命令复现全部结论**：`make report`

---

# 15. 部署与 CI/CD

## 15.1 CI 流程（GitHub Actions）

```yaml
on: [push, pull_request]

jobs:
  quality:
    - ruff check
    - ruff format --check
    - mypy --strict src/
  test:
    - pytest tests/unit --cov --cov-fail-under=85
    - pytest tests/chaos
  build:
    - docker build → push GHCR（仅 main 分支）
```

**CI 中禁止出现任何主网 API 密钥。** 集成测试用测试网密钥，存于 GitHub Secrets 且仅限受保护分支。

## 15.2 部署流程（三道锁）

```
push to main
  → CI 全绿
  → 构建镜像推 GHCR
  → 【锁 1：持仓闸门】调用 VPS /health 检查当前是否有持仓
        ├─ 有持仓 → 拒绝部署 + Telegram 通知 "待平仓后重试"
        │            （除非 PR 打了 force-deploy 标签）
        └─ 无持仓 → 继续
  → 停旧容器 → 拉新镜像 → 起新容器
  → 【锁 2：对账门】启动后强制 recon
        ├─ 对账失败 → 自动回滚到上一版本 + CRITICAL 告警
        └─ 对账通过 → 解除 system_ready 阻塞
  → 【锁 3：观察期】新版本运行 10 分钟内只读不下单
  → 正式接管
```

**`risk` 进程独立部署、独立版本，且与 `engine` 不同时更新。** 风控是最后的安全网，不能和策略一起挂。

## 15.3 运行时

```yaml
# docker-compose.yml 要点
services:
  engine:
    restart: unless-stopped
    volumes: [/data:/data, /var/run/fundarb:/var/run/fundarb]
    user: fundarb            # 非 root
  risk:
    restart: always          # 比 engine 更强的重启策略
    volumes: [/data:/data:ro, /var/run/fundarb:/var/run/fundarb]
    user: fundarb
  ui:
    restart: unless-stopped
    # 仅通过 Cloudflare Tunnel 暴露，不映射宿主机端口
  cloudflared:
    image: cloudflare/cloudflared
    command: tunnel run
```

## 15.4 Cloudflare 角色（明确边界）

| 组件 | 用途 | 说明 |
|---|---|---|
| Tunnel | 安全访问 UI | VPS **零入站端口**，不暴露公网 IP |
| Pages | 只读快照看板 | 引擎每 60s 推 JSON 快照到 R2，Pages 渲染。此路径**不接触任何交易权限** |
| R2 | 历史 Parquet + 每日备份 | 无出口费 |

🔴 **禁止**将 engine 或 risk 部署到 Workers / Durable Objects：其出口 IP 不固定，会导致交易所 API 白名单失效——那是本系统安全模型的第一层防护。

---

# 16. 安全规格

## 16.1 三层防护

### 第一层：交易所侧（最重要）

| # | 措施 |
|---|---|
| S1 | API 权限**只开合约交易**，**禁用提现**，禁用内部划转（若策略不需要） |
| S2 | **绑定 IP 白名单**到 VPS 固定出口 IP。这一条挡掉绝大部分风险 |
| S3 | 每个交易所使用**独立子账户**，只放该策略所需资金；主账户资产隔离 |
| S4 | `engine` 与 `risk` 使用**不同的 API 密钥**，便于事故时分别吊销 |

### 第二层：机器侧

| # | 措施 |
|---|---|
| S5 | VPS 仅开 SSH（密钥登录、禁 root、禁密码），其余入站端口全关（靠 Tunnel 出站） |
| S6 | 密钥用 `sops` + `age` 加密存盘，运行时解密进内存，不落明文文件 |
| S7 | `.gitignore` + `git-secrets` 预提交钩子 + GitHub Secret Scanning |
| S8 | 容器以非 root 用户运行，只读挂载尽可能多的路径 |
| S9 | 仓库**必须私有**（白名单、阈值参数本身即策略信息） |

### 第三层：行为侧

| # | 措施 |
|---|---|
| S10 | 单笔下单硬上限（§13.4 代码级常量） |
| S11 | 白名单交易对，非白名单不下单 |
| S12 | 每日累计下单额上限，触及即熔断 |
| S13 | 所有平仓单强制 `reduce_only` |
| S14 | 人工熔断文件 `HALT`（§9.3） |

## 16.2 密钥轮换

- 每 90 天轮换一次交易所 API 密钥
- 任何疑似泄露 → 立即在交易所侧吊销（不依赖代码）

---

# 17. 附录

## 17.1 P0 交付物清单（第一个可验证成果）

```
scripts/fetch_history.py
  输入: 交易所列表、交易对列表、时间区间
  输出: /data/funding_history/**/*.parquet
  要求: 断点续传、限流友好、失败重试、进度输出

scripts/backtest.py
  输入: Parquet 数据 + 成本参数
  输出: reports/screening_YYYYMMDD.md
        - 净 APR 排序表（交易所对 × 交易对）
        - 敏感性分析矩阵
        - 费率差时间序列图
  要求: make report 一条命令复现

验收: 净 APR > 12% 的组合数量 ≥ 5 → 继续；否则暂停项目重新评估
```

## 17.2 开发前必须核验的事项

| # | 事项 | 影响 |
|---|---|---|
| V1 | CCXT 是否对目标交易所收取 builder 费（约 1bp） | 决定下单路径是否必须自写 |
| V2 | 各所当前资金费率结算周期与动态调整规则 | 归一化正确性 |
| V3 | 各所费率上下限与计算基数 | 收益模型 |
| V4 | 各所 clientOrderId 长度与字符集限制 | 幂等键格式 |
| V5 | 各所是否提供测试网及其行为差异 | 集成测试方案 |
| V6 | 各所是否提供 ADL 排队等级接口 | ADL 探测实现 |
| V7 | 各所限流规则（权重制/次数制、是否分池） | 限流器设计 |
| V8 | VPS 出口 IP 是否固定、是否支持绑定 | 安全模型第一层 |

## 17.3 参考来源（仅作设计参考，不引入代码）

| 对象 | 参考什么 | 是否引入代码 |
|---|---|---|
| Hummingbot | Executor 状态机抽象、职责边界划分；**GitHub Issues 中 perpetual connector 的 bug 清单** | ❌ |
| nautilus_trader | 事件驱动架构、订单生命周期建模 | ❌ |
| freqtrade | 配置体系与回测工程化 | ❌ |
| CCXT | 市场元数据归一化、行情 WS、历史费率 | ✅ 仅限行情侧 |

> **P-1 阶段的核心任务**：把上述项目的缺陷清单转写成本文档 §11 的 FMEA 条目。代码复用省的是几天打字时间，避坑省的是几周排查时间加真金白银。

## 17.4 文档维护

- 本文档为**唯一需求真相源**。任何实现与本文档冲突时，先改文档再改代码
- 每次架构决策变更需在 `docs/ADR/` 新增记录，格式：背景 / 决策 / 理由 / 何时重新审视
- 版本号在文档头部维护

---

**文档结束**
