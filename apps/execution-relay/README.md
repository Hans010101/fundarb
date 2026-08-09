# 固定 IP 执行中继

中继部署在拥有固定公网出口 IP 的独立主机。它不接收 API Secret，不计算策略，也不是通用代理；仅转发 Cloudflare Worker 已签名、短时有效、路径在代码白名单内的交易所请求。

支持的接口：

- Binance USDⓈ-M：账户验证、市场委托
- Bybit Linear：账户验证、市场委托
- OKX USDT Swap：账户验证、市场委托
- Bitget USDT Futures：账户验证、市场委托

生产运行：

```bash
docker build -t fundarb-execution-relay .
docker run --restart=always -p 127.0.0.1:8788:8788 \
  -e FUNDARB_RELAY_TOKEN='与 Cloudflare EXECUTION_RELAY_TOKEN 相同的值' \
  fundarb-execution-relay
```

请通过 HTTPS 反向代理或 Cloudflare Tunnel 暴露，并把该主机固定出口 IP 加入每个交易所 API 白名单。真实交易前必须完成 Testnet 的超时、重复请求、第二腿失败和回滚演练。
