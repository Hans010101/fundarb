# 固定 IP 执行中继

中继部署在拥有固定公网出口 IP 的独立主机。它不接收 API Secret，不计算策略，也不是通用代理；仅转发 Cloudflare Worker 已签名、短时有效、路径在代码白名单内的交易所请求。

支持的接口：

- Binance USDⓈ-M：账户验证、市场委托
- Bybit Linear：账户验证、市场委托
- OKX USDT Swap：账户验证、市场委托
- Bitget USDT Futures：账户验证、市场委托
- Hyperliquid：Agent Wallet 验权、IOC 委托
- Gate.io USDT Futures：账户验证、市场委托
- WEEX Futures V3：账户验证、市场委托
- HTX USDT Swap：账户验证、最优五档委托
- Coinbase INTX：账户验证、USDC 永续市场委托

生产运行：

```bash
docker build -t fundarb-execution-relay .
docker run --restart=always -p 127.0.0.1:8788:8788 \
  -e FUNDARB_RELAY_TOKEN='与 Cloudflare EXECUTION_RELAY_TOKEN 相同的值' \
  fundarb-execution-relay
```

请通过 HTTPS 反向代理或 Cloudflare Tunnel 暴露，并把该主机固定出口 IP 加入每个交易所 API 白名单。真实交易前必须完成 Testnet 的超时、重复请求、第二腿失败和回滚演练。

## macOS 个人工作站模式

仓库同时提供与“点金手”一致的个人工作站方案：本机中继监听 `127.0.0.1:8790`，Quick Tunnel 每分钟向独立注册 Worker 上报临时入口，5 分钟无心跳即自动失效；公网 IPv4 变化时会立即停止中继。API Secret 始终只在 Cloudflare D1 中以 AES-256-GCM 密文保存，中继只接收 Worker 已签名且在白名单内的短时请求。

部署 `fundarb-relay-registry`、设置与主 Worker 相同的 `EXECUTION_RELAY_TOKEN` 后执行：

```bash
zsh apps/execution-relay/mac/install.zsh
```

输出的 IPv4 必须加入 Binance、OKX、Bitget API Key 的 IP 白名单。Mac 需要保持联网且不进入深度睡眠；长期无人值守实盘应把同一中继镜像迁移到固定 IP VPS。
