# FundArb 实盘运维手册

## 当前安全状态

生产部署初始值为 `Paper`、紧急停止开启、真实委托关闭、主网许可关闭。静态或动态执行中继不可用时，Worker 会硬拒绝 Testnet 和 Live 下单。

## 凭证边界

- Cloudflare Access：个人控制台的主登录方式，仅放行 `hans.pan007@gmail.com`；Worker 还会验证 JWT 签名、团队域名、应用受众与邮箱。
- `ADMIN_API_TOKEN`：只作无界面的应急恢复凭证，前端不再显示输入框；只存 Cloudflare Secret，本机副本存 macOS 钥匙串。
- `CREDENTIAL_MASTER_KEY`：交易所 API 密文的 AES-256-GCM 主密钥，只存 Cloudflare Secret，不保留本机副本。
- `EXECUTION_RELAY_TOKEN`：主 Worker、注册 Worker 与执行中继之间的共享凭证，只存 Cloudflare Secret；macOS 工作站副本存钥匙串服务 `com.fundarb.execution-relay.token`。
- 交易所 API Key/Secret：浏览器提交后由 Worker 加密写入 D1，接口永不回显明文。

## 出口中继

### macOS 个人工作站

1. 部署主 Worker 与 `wrangler.registry.jsonc` 定义的独立注册 Worker，并为两者设置同一个 `EXECUTION_RELAY_TOKEN`。
2. 执行 `zsh apps/execution-relay/mac/install.zsh`。脚本会安装三个 LaunchAgent：本机中继、Quick Tunnel 和每 5 分钟运行一次的出口 IP 守护。
3. 中继每分钟注册一次临时入口；Worker 只接受根路径为 `*.trycloudflare.com` 的地址，验证注册地址来源 IP 和中继健康状态，5 分钟无心跳即失效。
4. 把安装脚本输出的 IPv4 加入 Binance、OKX、Bitget API Key 白名单。IP 变化时本机中继会自动停止，更新白名单并重新安装前不得下单。
5. Mac 必须保持联网且不进入深度睡眠。这适合个人测试和早期小额运行，不适合长期无人值守实盘。

### 固定 IP VPS

1. 在具有静态公网 IP 的主机部署 `apps/execution-relay/Dockerfile`。
2. 从 macOS 钥匙串读取中继凭证并安全写入主机 Secret 管理器：`security find-generic-password -w -s com.fundarb.execution-relay.token`。
3. 只允许 Cloudflare 到中继的 TLS 入站；中继必须置于 HTTPS 反向代理后，并设置 `FUNDARB_RELAY_TOKEN`。
4. 将该固定公网 IP 加入每个交易所 API Key 的 IP 白名单。
5. 更新 `wrangler.jsonc` 的 `EXECUTION_RELAY_URL` 后重新生成类型、测试并部署；静态中继优先用于长期无人值守实盘。

中继不是通用代理：代码只允许 Binance、OKX、Bybit、Hyperliquid、Gate.io、Bitget、WEEX、HTX、Coinbase INTX 的账户验权、下单路径及指定公开行情路径，并限制方法、请求头、请求体大小及重复 requestId。

Binance、Bitget 等平台可能从 Cloudflare 共享出口返回 WAF 403，OKX 等平台也可能返回共享 IP 429。这不应被解释为“没有行情”或“没有套利机会”。配置固定出口后，Worker 会先尝试直连，失败再经白名单中继拉取；控制台会保留每一路的真实在线状态与错误信息。

## 上线顺序

1. Paper：保存两个连接，创建和关闭模拟套利交易，核对 D1 账本。
2. Testnet：部署固定出口中继，添加测试网 API，验权并启用连接；解除紧急停止、打开真实委托许可，模式切换为 Testnet。
   Binance 与 OKX 账户需使用单向/净持仓模式，Bitget 需使用 one-way mode；当前下单器以 reduce-only 保护平仓，尚未为双向持仓模式生成 `positionSide` / `posSide` / `tradeSide`。
3. 故障演练：分别验证第一腿拒绝、第二腿拒绝、超时状态不明、回滚失败、部分平仓和 Worker 重启。
4. Live：使用禁提现的独立子账户和 IP 白名单；只开 BTC/ETH、小名义、低杠杆；再打开主网许可并输入双重确认语句。

## 尚未自动化的生产门槛

- 交易所订单/成交/持仓的持续轮询或 WebSocket 对账。
- 部分成交后的精确剩余量修复与净 Delta 守护。
- 保证金、强平距离、ADL、稳定币和单所信用限额。
- 预测资金费与实际到账的自动 PnL 归因。
- 独立于主应用的风险守护进程和告警通道。

因此，在上述门槛完成前，Testnet 可用于全链路验证；Live 必须保持人工盯盘、小额和随时可在交易所原生界面接管。
