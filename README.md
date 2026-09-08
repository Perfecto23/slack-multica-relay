# Slack → Multica Relay

[English](README_EN.md) | **简体中文**

一个面向可靠交付的 Slack → Multica 桥接服务：接收经过签名验证的 Slack mention，经 QStash 持久化后，将每个 Slack thread 映射为一个 Multica Issue，并把后续消息作为 comment 送入同一个 Agent 工作流。

## 为什么需要它

直接把 Slack event 转成 Agent 任务，很容易混淆“Slack 已确认”“任务已持久化”“Agent 已完成”和“回复已送达”。本项目把这些阶段拆开，并分别处理准入、重试、上下文、幂等与最终回复：

- Slack 只有在 QStash 接受事件后才收到成功响应；
- queue consumer 再次执行相同准入策略；
- Redis 保存线程映射、事件快照和 Multica 写入状态；
- Multica Issue/comment 使用稳定 marker 恢复结果不明的写入；
- 本地 reply adapter 使用持久 delivery ledger，避免结果不明时重复发送 Slack 消息。

## 核心能力

- **严格准入**：校验 Slack 签名与时间戳，并支持 Team、mention target、channel、sender 的 allowlist/blocklist。
- **持久化接收**：使用 QStash 解耦 Slack 的短响应窗口与后续上下文读取、Multica 写入。
- **Thread → Issue 路由**：同一 Slack thread 首次创建 Issue，后续 mention 追加 comment。
- **有界对话上下文**：读取 mention 前 24 小时内最多 40 条主时间线消息，始终保留当前线程，并展开最多五个最近活跃旁支。
- **独立可读的 follow-up**：后续 comment 携带当前线程、最近回复以及新增、更新或显式引用的相关旁支，无需 Agent 合并 delta。
- **可检查的裁剪**：分页、消息数量、响应大小和 envelope 字节上限都会留下 `truncated` 或 `unavailable` 状态。
- **隐私最小化**：Slack file object 在进入 QStash 前完成字段投影；private URL、thumbnail、shares、下载内容和凭据不会进入队列 payload。
- **确定性 footer**：显示名、配置 model 和 Fast 标记由 adapter 代码生成，不依赖模型正文。
- **最终发送去重**：每个来源 Issue/comment 对应稳定 delivery block ID；本地 ledger 记录 `attempting → accepted → sent`。
- **多平台入口**：共享核心逻辑可由 Vercel Functions、EdgeOne Cloud Functions 或 Cloudflare Workers 承载。

## 工作流程

```text
Slack mention
  │
  ├─ 签名、时间戳与准入校验
  ▼
QStash
  │  持久化、按 thread 串行、有限重试
  ▼
Queue consumer
  ├─ 再次校验准入策略
  ├─ 读取有界 Slack 上下文
  ├─ 使用 Redis 恢复线程与事件状态
  └─ 创建 Multica Issue 或追加 comment
       │
       ▼
Configured Multica Agent
       │
       └─ 本地 scripts/slack-reply.py
            ├─ 回读来源 envelope
            ├─ 生成正文 blocks 与 footer
            ├─ 持久化 delivery ledger
            └─ 回复原 Slack thread
```

Relay 部署环境和 Agent Runtime 是两个独立的信任域。Vercel/EdgeOne/Cloudflare 负责入口、队列消费和 Multica 路由；私有 Agent Instructions、Skills、Slack user token 与 reply adapter 配置保存在执行 Agent 的 Runtime。

## 上下文模型

每条新 mention 都会生成一个冻结的 versioned envelope。它以本次消息为截止时间，读取有界的 24 小时主时间线，始终保留当前线程，并只展开最近活跃的有限旁支。分页必须到达最新后缀后才能把内容描述为“最近回复”；读取、权限或字节预算不足时，envelope 会明确标记缺失范围。同一事件的重试复用冻结输入，新 mention 才重新采集上下文。

完整数据结构、精确数量、分页和失败语义见 [Slack 上下文组装](docs/CONTEXT-ASSEMBLY-DESIGN.md)。

## 可靠性语义

项目明确区分以下状态：

1. Slack event 已通过准入；
2. QStash 已接受；
3. Multica Issue/comment 已持久化；
4. Agent 已运行；
5. Slack 最终回复已送达。

HTTP 200、reaction、Issue 创建或 deployment ready 都只证明对应阶段。

Multica 写入通过 Redis 状态和稳定 marker 处理重试。最终 Slack 回复由本地 ledger 管理：`sent` 会直接复用已核验结果；若 POST 结果未知，adapter 会回读原线程，但查询为空不会触发自动重发，而是返回 `slack_delivery_unknown`，等待独立核对。这一选择优先避免重复发言。

## 项目结构

```text
api/                         Vercel Functions 入口
cloud-functions/             EdgeOne Cloud Functions 入口
src/cloudflare.ts            Cloudflare Workers 入口
wrangler.jsonc               Workers 部署配置
src/                         共享 Relay、上下文、路由与持久化逻辑
scripts/slack-reply.py        本地 Slack 回复 adapter
public/                      静态 health 页面资源
docs/CONFIGURATION.md         完整配置与信任边界
docs/CONTEXT-ASSEMBLY-DESIGN.md
                              上下文、恢复与展示合同
tests/                       TypeScript 与 Python 测试
```

## 准备条件

部署 Relay 前需要：

- Node.js 22.12+（推荐 Node.js 24 LTS）与 pnpm 10；
- 一个配置了 Events API 的 Slack App；
- QStash；
- Relay 专用 Upstash Redis；
- 可访问目标 Workspace、Project 和 Agent 的 Multica PAT；
- Vercel、EdgeOne 或 Cloudflare Workers 部署环境。

如需通过本地 adapter 以指定 user identity 回复，还需要：

- Python 3；
- 已认证的 Multica CLI；
- 绑定到目标 Agent 的本地 Multica Runtime；
- 具有 `chat:write` 和目标会话 history scope 的 `SLACK_USER_TOKEN`。

仓库通过 `.nvmrc` 和 `.node-version` 默认选择 Node.js 24，同时支持 Node.js 22.12+。托管构建也推荐选择 24；Cloudflare Workers 使用 workerd 执行，构建用的 Node.js 版本与 Worker 运行时独立。

## 本地安装与验证

```bash
git clone https://github.com/Perfecto23/slack-multica-relay.git
cd slack-multica-relay
pnpm install --frozen-lockfile
pnpm test
pnpm lint
```

`.env.example` 列出 Relay 部署所需变量。部署或本地联调时，将需要的值配置到目标平台或私有环境；不要提交 `.env.local`、prompt、persona、私有部署记录或任何凭据。

完整变量来源、Runtime 配置和部署验收步骤见 [配置说明](docs/CONFIGURATION.md)。

## 部署入口

| 平台 | Slack Events | Queue consumer | Health |
| --- | --- | --- | --- |
| Vercel | `/api/slack/events` | `/api/queue/consume` | `/api/health` |
| EdgeOne | `/api/slack/events` | `/api/queue/consume` | `/api/health` |
| Cloudflare Workers | `/api/slack/events` | `/api/queue/consume` | `/api/health` |

### Vercel / EdgeOne

1. 在 Vercel 或 EdgeOne 中导入本仓库；平台配置已分别保存在 `vercel.json` 和 `edgeone.json`。
2. 按 [配置说明](docs/CONFIGURATION.md) 创建 Relay 环境变量，并把 token、PAT 和 signing key 放入平台 Secret Store。
3. 确定公开域名后，将 `RELAY_CONSUMER_URL` 设置为该域名下准确的 `/api/queue/consume`；它必须与 QStash 实际调用和验签使用的 URL 完全一致。
4. 部署通过测试的 immutable commit，回读 `/api/health`。
5. 将 Slack App Request URL 指向 `/api/slack/events`，完成 URL verification，并只订阅目标会话类型需要的 message events。
6. 在授权测试频道发送一条 mention，分别核验 QStash 接收、Multica Issue/comment、reaction identity、Agent execution 和原 thread 最终回复。
7. 再用 blocked channel 或 sender 验证不会产生 QStash 与 Multica 副作用。

配置、deployment ready 或 HTTP 200 只能证明对应阶段，不能代替完整链路验收。

### Cloudflare Workers

使用 `pnpm dev:cf` 本地运行、`pnpm build:cf` 离线构建；配置账号和 Secrets 后使用 `pnpm deploy:cf` 发布。完整步骤见 [Cloudflare 配置](docs/CONFIGURATION.md#cloudflare-workers)。Workers 承载 Relay；QStash、Upstash Redis 和私有 Multica Runtime 仍为必要组件。

## 本地 reply adapter

```bash
python3 scripts/slack-reply.py --help
```

adapter 从来源 Issue/comment 回读 route 与 `replyContext`，从私有 JSON 读取固定 `displayName` 和绑定 ID，再使用 `SLACK_USER_TOKEN` 发送 Block Kit 消息。Agent 只撰写正文；attribution、model 与 Fast 标记由代码追加。

私有 JSON、Runtime Skills 和 Agent prompt 不属于本仓库。修改本地 prompt 文件不会自动改变 Multica Agent；必须通过 `multica agent update --instructions` 显式同步并回读。

## 验证

```bash
pnpm test   # Vitest + Python unittest
pnpm lint   # TypeScript typecheck
```

测试覆盖签名、准入、QStash 投影、线程映射、Multica 写入恢复、上下文分页与裁剪、follow-up selection、footer 渲染，以及本地 delivery ledger 的结果不明和并发边界。

离线测试证明代码合同，不证明实际 deployment、Agent execution 或 Slack 用户可见回复。真实发布验收必须使用授权测试频道逐阶段回读。

## 安全与隐私

- 凭据只通过部署平台 Secret Store 或私有 Runtime 环境提供；
- Slack 原始附件对象不会进入 QStash；
- 日志记录摘要、计数、耗时和稳定错误码，不记录聊天正文、姓名、附件内容或 token；
- Redis 与 QStash 会处理选中的 Slack 文本，应按消息敏感度配置访问和保留策略；
- 私有 prompt、persona、Skills 和 reply adapter 配置不得提交到公开仓库。

## 文档

- [配置说明](docs/CONFIGURATION.md)
- [Slack 上下文组装合同](docs/CONTEXT-ASSEMBLY-DESIGN.md)
- [Multica 操作说明](docs/MULTICA-OPERATIONS.md)
- [贡献指南](CONTRIBUTING_ZH.md)

## 许可证

本仓库当前尚未声明开源许可证。源码公开可见不等同于自动授予使用、修改或分发权；在维护者选择并提交 `LICENSE` 前，请勿假定存在这些授权。

## 来源

本项目最初基于 [winchesHe/slack-multica-relay](https://github.com/winchesHe/slack-multica-relay)，现由本仓库独立维护实现与历史。
