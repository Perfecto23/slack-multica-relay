# 贡献指南

[English](CONTRIBUTING.md) | **简体中文**

感谢你改进 Slack → Multica Relay。所有改动都应保留 Slack 准入、队列持久化、Multica 写入、Agent 执行和 Slack 最终送达之间的明确边界。

## 开始之前

1. 阅读 [AGENTS.md](AGENTS.md)，了解项目不变量和完成标准。
2. 修改环境变量、部署或信任边界时，阅读[配置说明](docs/CONFIGURATION.md)。
3. 修改上下文、envelope、marker、恢复、展示、footer 或 delivery ledger 时，阅读 [Slack 上下文组装](docs/CONTEXT-ASSEMBLY-DESIGN.md)。
4. Issue 或 pull request 保持单一目标，无关重构单独处理。

Issue、测试 fixture、日志、commit 和 pull request 都不得包含凭据、私人 Slack 内容、prompt、persona 或私有部署记录。复现材料必须先脱敏。

## 开发环境

```bash
git clone https://github.com/Perfecto23/slack-multica-relay.git
cd slack-multica-relay
pnpm install --frozen-lockfile
```

本地 reply adapter 测试需要 Python 3。确定性测试套件不需要 live Multica 或 Slack 凭据。

## 修改要求

- 保持每项行为现有的责任 owner。协议变更必须在同一改动中更新实现、类型、合同文档和最小有效回归测试。
- Relay 管理的任务协议不进入 Agent 人格 Instructions；私有 Runtime 配置不进入本仓库。
- 明确分类重试行为。操作可能成功但结果不明时，没有幂等合同或独立回读就不能重放。
- Slack 数据在外部持久化前完成最小化；日志不记录消息正文、附件内容、private URL 或 token。
- 最小化首先减少可选背景和排版开销。根、上次已交付 mention 及其后的全部同线程发言属于必需区间；不得按条数、作者或表情筛掉其中消息。阈值、失败行为和旧格式兼容以 [上下文合同](docs/CONTEXT-ASSEMBLY-DESIGN.md) 为准。
- 当前合同没有直接要求时，不新增依赖、兼容层或抽象。

## 验证

提交 pull request 前运行：

```bash
pnpm test
pnpm lint
git diff --check
```

测试应覆盖被修改的成功路径，以及相关失败、重试、裁剪、并发或隐私边界。离线测试只证明代码合同，不证明部署、Agent run 或用户可见 Slack 回复。

上下文改动重点核对 [区间测试](tests/context-interval.test.ts)、[路由恢复测试](tests/thread-router.test.ts) 和 [展示兼容测试](tests/task-presentation.test.ts)：长区间不能丢消息，失败不能推进边界，乱序不能回退边界；早于首次入库请求的迟到消息保留原背景时间并过滤未来根及回复；恢复失败不能当作“没有 A”。历史请求补入须有 restoredFrom 标记，紧凑展示仍须恢复同一个请求和回复目的地。Worker 相关改动还需运行 `pnpm build:cf`。私有真实样本只留在仓库外或已忽略目录。

涉及 Footer 或模型快照读取时，同时检查 [正文保真测试](tests/slack-message-text.test.ts) 和 [workerd 配置读取测试](tests/reply-context-runtime.test.ts)。普通 fetch mock 无法证明 workerd 支持某个 RequestInit 参数。

## Pull request 说明

Pull request 应说明：

- 具体触发条件和原行为；
- 修改后的行为与责任模块；
- 合同或隐私影响；
- 已执行的验证；
- 尚未验证的 live 环节。

HTTP 200、deployment ready、Issue persisted、Agent completed 和 Slack delivered 必须作为不同证据陈述。
