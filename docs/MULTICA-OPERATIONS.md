# Multica 操作说明

[English](MULTICA-OPERATIONS_EN.md) | **简体中文**

本文件用于操作与 Slack Relay 关联的 live Multica Workspace、Agent、Project、Issue、run、Skill 和 Runtime。普通代码修改不需要加载本文件。

## 固定目标

1. 先运行 `multica --help` 和目标子命令 `--help`，以本机安装版本为准。
2. 通过 `list/get` 核对完整 UUID、Workspace 和关联对象；当前目录、同名对象或旧聊天记录不能替代身份核对。
3. 每次调用显式传入已核对的 `--workspace-id`。使用 `--server-url` 或 `--profile` 时整轮保持一致，不为单次任务修改全局默认配置。
4. 结构化读取使用 `--output json`；完整列表按响应支持的 cursor、`has_more` 或 offset 分页，不解析表格中的截断 ID，也不把 stderr 混入 JSON。

CLI 缺失、认证失败或能力不足时先定位原因。浏览器不作为默认配置入口。

## 常用读取

| 目的 | 命令（补上已核对的 Workspace 参数） |
| --- | --- |
| Agent | `agent list` / `agent get <id>` |
| Project | `project list` / `project get <id>` |
| Issue | `issue list` / `issue get <id>` / `issue search <query>` |
| Issue 评论 | `issue comment list <issue-id> --roots-only --summary` 定位，再用 `--thread <comment-id> --tail 0` 回读目标根评论全文 |
| 执行记录 | `issue runs <issue-id>` |
| 某次执行的消息 | `issue run-messages <task-id>` |
| Runtime | `runtime list` |
| Agent、Skill、Workspace 配置 | 读取对应子命令 `--help` 后使用当前 CLI 支持的命令 |

Issue 是任务卡，run 是一次执行；`run-messages` 接收该次执行的 task ID。Agent 名称字段为 `name`，Project 使用 `title`。

列表可能是数组或带 `issues`、`has_more`、`offset` 的分页对象，按实际 JSON 结构读取，不能把对象误判为空列表。`--summary` 只用于定位，核对 envelope 时读取目标全文。附件归属依赖 `source_task_id`，此时不要使用会移除该字段的 `--compact`。

## 核对 Relay 上下文

1. 首次请求读取 Issue description；后续请求先定位 `relay-message` 根评论，再回读该评论完整内容。Agent 的答复和触发评论是不同记录。
2. 核对 `eventPayload` 的 team、channel、thread 和 message 时间戳与目标 Slack 请求一致。新事件使用 `schemaVersion: 7`；已冻结事件的重试或历史 Issue/comment 恢复继续兼容 `v1..v6`。
3. 核对顶部 Markdown 现场头（会话类型、频道名与人数、发送者身份与 `Asia/Singapore` 时间）及对话区：线程内首次触发包含根消息与最近 20 条前序回复；根消息触发最多带前 10 分钟 5 条紧邻根消息；同线程后续追问只携带 `(sinceTs, messageTs)` 之间的新增本线程回复，不再把对话树重复塞入底部 `<!-- relay-payload:v1 -->` JSON。
4. 核对行内 `<@U...>` 是否解析为真实姓名、`小 p (Agent 已回复)` 是否已剥离签名 Footer、转发卡片与 Block Kit 富文本是否提取完整，以及 `not_loaded` 附件是否在需要看图或读链接时生成了 `moe-slack` 按需提示。
5. 通过 `relay_context`（含 `channelCacheHit`、`userCacheHits`、`envelopeBytes`）核对读取与目录缓存命中，通过 `relay_dispatch` 核对写入结果，再独立查看 run 和原线程回复。不要因 Issue 已存在就声称本次请求已经送达。

`context_required_page_limit`、`context_required_unavailable` 和 `context_request_too_large` 表示必需上下文未能完整交付，consumer 会拒绝启动并保留原边界。暂时性的 429、5xx、超时交由有限重试。不要清理 Redis 或 delivery ledger 来强行重发。完整合同见 [Slack 上下文组装](CONTEXT-ASSEMBLY-DESIGN.md)。

Agent 历史回复通过签名 `relay-delivery-<sha256>` block 识别并剥离 Footer，核对时应对照原始 Slack blocks 的正文部分，不能要求与含 Footer 的 fallback text 完全相同。`replyContext.status=unavailable` 与执行统计中的模型是不同证据；读取失败时检查 Worker 的请求模式、上游状态和身份校验，不据此判定 Agent 没有运行。风格文件读取失败则核对私有 styleGuide 和 SKILLS.md 索引的实际路径。

## 更新 Agent 配置

恢复 API 失败或状态损坏不能降级成“没有上次 mention”；按实际错误分类处理，不修改 Agent 配置来绕过恢复失败。

1. 用 `agent get` 锁定当前 Agent 和完整配置，只更新已授权字段。
2. `--instructions` 替换整份内容。完整候选保存在仓库外，并保留本次范围未涉及的现行规则。
3. 多行内容使用程序参数数组传给 CLI，不拼接 shell 命令；凭据不得进入 instructions 或 argv。
4. 更新后按相同 server、Workspace 和 Agent ID 回读目标字段。结果不明时先核对现状，不重复写入。
5. Skill binding 变更回读完整绑定列表；model、reasoning effort 和 service tier 必须与目标 Runtime 支持范围一致。

配置保存、deployment ready、Issue/comment persisted、Agent completed 和 Slack reply delivered 是不同状态。只读验证不触发 Agent task。
