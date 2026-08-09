# FundArb

个人使用的跨交易所永续合约套保交易终端。实时聚合 Binance、Bybit、OKX、Bitget、Hyperliquid、Gate.io、KuCoin、MEXC 与 Phemex 共 9 路 USDT 永续行情，按实际结算周期统一到 8 小时；同时提供加密账户保险箱、Paper/Testnet/Live 三种模式、双腿开平仓状态机和三道交易总闸。

> 系统具备真实交易接口，但生产环境默认开启紧急停止，并关闭真实委托和主网许可。固定 IP 执行中继未配置前，后端会硬拒绝 Testnet/Live 请求。它不构成投资建议。

## 本地运行

需要 Node.js 22+。

```bash
npm install
npm run build
npx wrangler dev
```

开发前端时可另开终端运行 `npm run dev`，Vite 会把 `/api` 代理到本地 Worker。

## 验证

```bash
npm run type-check
npm test
npm run test:relay
npm run build
npm run deploy:dry
```

## 部署

```bash
npm run deploy
```

推送到 `main` 后 GitHub Actions 会先执行类型检查、测试和构建。配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 两个 Actions Secrets，并把仓库变量 `CLOUDFLARE_DEPLOY_ENABLED` 设为 `true` 后，每次主分支更新都会自动部署；未配置时部署 job 会安全跳过。

架构边界见 [ADR 0001](docs/adr/0001-runtime-boundary.md)，完整专业评审与路线图见 [产品评审](docs/PRODUCT_REVIEW.md)。原始规格存档于 `docs/FUNDARB_SPEC.md`。

## API

- `GET /api/health`：服务状态与执行总闸。
- `GET /api/scan`：实时机会矩阵。
- 查询参数：`feeBps`、`slippageBps`、`periods`、`maxPeriods`、`minApr`、`minVolume`。
- `GET /api/admin/status`：账户、模式、总闸与套保任务（需通过 Cloudflare Access 邮箱身份校验）。
- `POST /api/admin/connections`：加密保存交易所 API 凭证。
- `POST /api/admin/connections/:id/verify`：经固定 IP 中继执行账户验权。
- `POST /api/admin/hedges`：创建 Paper/Testnet/Live 双腿委托。
- `POST /api/admin/hedges/:id/close`：以 reduce-only 双腿平仓。

## 交易所覆盖

| 交易所 | 资金费行情 | 账户验权与真实委托 |
| --- | --- | --- |
| Binance / Bybit / OKX / Bitget | 是 | 是 |
| Gate.io / KuCoin | 是 | 是 |
| Hyperliquid / MEXC / Phemex | 是 | 暂未开放 |

行情接口会逐路显示在线状态、合约数量与上游错误，不会用静态模拟数据掩盖故障。Cloudflare 边缘出口可能被个别交易所的 WAF 或共享 IP 限流；`EXECUTION_RELAY_URL` 配置后，行情请求会在直接访问失败时自动回退到同一个固定 IP 白名单中继。

## 安全边界

公开仓库只保存业务代码。个人控制台由 Cloudflare Access 保护，Worker 会再次校验 Access JWT 的签名、签发方、应用受众及授权邮箱；`ADMIN_API_TOKEN` 仅保留作无界面的应急恢复通道。交易所密钥在 Worker 内使用 AES-256-GCM 加密后写入 D1；加密主密钥、应急管理凭证和中继凭证仅存在 Cloudflare Secret。真正的账户验权与委托请求必须经过 `apps/execution-relay` 固定出口中继，该中继只允许预设交易所主机、路径、方法和请求头。交易账户必须使用独立子账户、禁提现和 IP 白名单。公开行情优先从 Worker 直连；遇到 WAF、地域策略或共享出口限流时才使用同一中继降级。

上线顺序与中继配置见 [实盘运维手册](docs/LIVE_OPERATIONS.md)。

## License

MIT
