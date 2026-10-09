# Cloudflare 002 迁移记录

状态：**部分完成，尚未独立承接**（2026-10-10）。

## 已核对

- FundArb 运行资源只有主 Worker、执行中继注册 Worker 与一个 D1 数据库；仓库未配置 KV、R2、Durable Object、队列、工作流、定时任务或自定义域名。
- 主 Worker 需要 `ADMIN_API_TOKEN`、`CREDENTIAL_MASTER_KEY`、`EXECUTION_RELAY_TOKEN` 三个 Secret；明文只保存在本机忽略文件中，不进入仓库。
- 2026-10-02 的 D1 备份包含 10 项平台设置，没有交易所账户、交易意图、订单或审计记录。安全状态为 Paper、紧急停止开启、真实委托关闭、主网交易关闭。
- 本地 29 项测试、生产构建与 TypeScript 检查通过；迁移不得改变资金费率、成本回收周期、交易配对和风控逻辑。
- GitHub Actions 工作流通过仓库 Secret 注入 Cloudflare 账号和 API Token，源码中未写死账号 ID；仓库端 Secret 是否已切换到 002 仍待账号权限恢复后核验。

## 尚未执行

- 在 002 创建新的 D1，并使用最新线上快照恢复和核对表、行数及安全开关。
- 在 002 部署 `fundarb-web` 与 `fundarb-relay-registry`，写入三个 Worker Secret，并把两个 Wrangler 配置绑定到新 D1。
- 在 002 创建 Cloudflare Access 应用、策略和 JWT audience，再更新 `TEAM_DOMAIN`、`POLICY_AUD` 与允许邮箱。
- 更新网页文件协议跳转地址和 macOS 中继注册地址为 002 的 Workers 域名。
- 把 GitHub Actions 的发布凭据切换到 002，并完成一次从 `main` 分支触发的发布验证。

## 当前阻塞

- 共享 Cloudflare OAuth 已过期；按总迁移约束，本项目不能自行刷新、重置或新建共享凭据。
- 2026-10-09 的 007 Worker 清单未列出 FundArb，但仓库生产配置和历史访问地址指向 007。恢复账号级只读权限后，必须先确认最新线上脚本、D1 更新时间和部署归属，不能用旧本地构建或 10 月 2 日备份直接覆盖。
- 目标 Access 应用尚无可核验的团队域名和 audience；在这些值确定前，不能安全删除 007 Access 依赖。

## 完成标准

只有同时满足以下条件才可把状态改为“独立承接完成”：

1. 002 主站与注册 Worker 均可访问，管理接口由 002 Access 独立鉴权。
2. D1 表、行数、平台开关及加密凭据可用，且 `CREDENTIAL_MASTER_KEY` 未发生不兼容变化。
3. 行情扫描和 Paper 双腿交易通过；不启用真实委托或主网交易。
4. GitHub `main` 分支可以只凭 002 发布凭据完成部署。
5. 运行配置、发布配置和中继安装脚本均不再引用 007；007 资源只保留为只读备份。
