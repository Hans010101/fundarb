# FundArb

跨交易所永续合约资金费率研究雷达。实时聚合 Binance、Bybit、OKX、Bitget 与 Hyperliquid，按实际结算周期统一到 8 小时，并用四腿手续费、滑点与持有期计算成本后年化和回本期数。

> 当前是只读市场数据产品：不接收 API Key、不保存账户信息、不发送订单。它不是实盘交易机器人，也不构成投资建议。

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

## 安全边界

真实执行器不得部署到 Cloudflare Workers。它需要固定出口 IP、交易所 API 白名单、独立子账户、禁提现、engine/risk 独立密钥、持久化幂等订单和启动对账。公开仓库中不得提交交易所密钥、账户参数或 live 开关。

## License

MIT
