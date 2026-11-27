# Slack 上下文组装（v7）

[English](CONTEXT-ASSEMBLY-DESIGN_EN.md) | **简体中文**

Relay 采用「**轻量精准推现场 + 深度背景由 `moe-slack` 主动拉**」的分工模型：入站消息渲染为对人类与 Agent 均直接可读的 Markdown 现场描述，底部 `<!-- relay-payload:v1 -->` 仅保留确定性回复路由所需的紧凑 JSON（`schemaVersion: 7`）。

## 1. 推与拉的职责边界

B 为本次入站消息；A 为同一 `workspace / project / scope / thread` 中早于 B、且已确认持久化到 Multica 的最近一次入站消息（记录在 `ThreadState.lastDeliveredTs`）。

| 场景 | Relay 被动推送范围 | 按需主动拉取（`moe-slack`） |
| --- | --- | --- |
| **会话与人物画像** | `conversations.info` 与 `users.info`（经 `ThreadStore` 批量 `MGET` 缓存 24h）：输出 `#频道名`、精确类型（`1v1 私聊` / `多人私聊 mpim` / `私有频道` / `公共频道`）、成员人数、首帖频道 Topic、发送者及正文内所有 `<@U...>` 的显示名，明确区分 `本人`、`小 p (Agent 已回复)`、同事与 `[Bot]` | 查询不在场成员、邮箱或频道列表时使用 `users` / `channels` / `resolve` |
| **会话根消息首次触发**（`messageTs === threadTs`） | 本次根消息 + 同一会话 `[B - 10 分钟, B)` 内最近最多 **5 条紧邻主消息**（不展开旁支线程，专门承接连发消息/先贴图后 `@`） | 需要浏览更早频道讨论时执行 `history --channel <id> --limit 1d --include-thread-replies` |
| **线程内首次触发**（`messageTs !== threadTs`，尚无 A） | 线程根消息 + 最近最多 **20 条前序回复** + 本次消息（不拉取频道旁支消息；超出 20 条时标注省略条数与原消息链接） | 需要完整长线程时执行 `replies --url <原消息链接>` |
| **同线程后续追问 / Steer / 合并** | `(A, B)` 之间本线程新增回复（最多保留最近 **30 条**）+ 本次消息；不重复搬运首次附近频道消息或已交付的旧回复 | 怀疑历史消息刚被编辑/撤回或需要回溯更早段落时执行 `replies --url <原消息链接>` |
| **链接与附件** | 提取转发引用、卡片标题/正文及 Block Kit 文本；当请求或当前线程含图片时列出最多 **6 张必看图片**（`<= 10 MB`）的 `fileId`；检测到 Slack permalink 时提示按需主动读取，不在 Worker 内被动抓取窗口 | 跨频道/同频道 Slack 链接由 `replies/get --url` 读取；图片与文件由 `files_download` 下载 |

## 2. 展示结构与紧凑数据合同

每条 Multica Issue 描述与追问评论均由两部分组成：

1. **Markdown 现场描述**：
   - 标题行：`## Slack 请求 · #频道名（类型 · 人数 · channelId）`（追问为 `## Slack 线程追问 · ...`）。
   - 元数据：发送者、精确 `Asia/Singapore` 时间与距上一条发言间隔、触发方式（显式 `@` / 称呼唤醒 / 编辑补 `@` / 活跃线程免 `@` 跟帖）及可直接传给 `moe-slack --url` 的 Slack 原消息链接。
   - 前序对话 / 增量新消息列表：每行格式为 ``- `[HH:MM:SS]` **作者**: 内容``（跨日自动带 `YYYY-MM-DD`），内联展示附件元数据。
   - `### 本次消息` 引用块及按需出现的「必看图片」「按需主动补读」提示。
   - 外部文本在进入 Markdown 前移除/转义 `<!--`、`-->`、`[@` 与 `mention://` 控制序列，并约束行首标题，防止伪造 Multica 派单或破坏 payload 围栏。
2. **底部紧凑路由 JSON（`<!-- relay-payload:v1 -->`）**：

```json
{
  "schemaVersion": 7,
  "eventPayload": {
    "teamId": "T1",
    "channelId": "C1",
    "channelType": "private",
    "channelName": "dev-moego-receptionist",
    "threadTs": "1000.000001",
    "messageTs": "1100.000001",
    "senderUserId": "U1",
    "senderName": "Nook",
    "text": "原始未改写请求文本",
    "mention": { "type": "user", "id": "U2" },
    "files": []
  },
  "replyContext": {
    "type": "slack_reply_context",
    "source": "agent_config",
    "agentId": "A1",
    "capturedAt": "2026-11-27T00:00:00.000Z",
    "status": "available",
    "model": "gemini-4-hydrogen-medium",
    "serviceTier": null
  }
}
```

对话历史只出现在上方 Markdown 中，不在 JSON 内重复存储整棵消息树。`scripts/slack-reply.py` 继续从 `eventPayload` 与 `replyContext` 读取回复目的地与模型快照；`readTaskEnvelope` 同时兼容历史 `v1–v6` 任务正文。

## 3. Agent 自发消息降噪与卡片提取

- 带 `relay-progress-<64位十六进制>` 尾块的临时进度卡在入站和上下文读取时直接跳过。
- 带 `relay-delivery-<64位十六进制>` 尾块的已送达回复提取正文并剥离统计/签名栏，在对话区标记为 `小 p (Agent 已回复)`。
- 普通消息与 Bot 消息在 `raw.text` 为空或带转发附件时，自动从 `blocks`（`rich_text` / `section` / `header` / `table`）和 `attachments`（`title` / `text` / `fallback`）补齐可读正文。

## 4. 预算、缓存与恢复不变量

- **准备快照冻结**：同一事件的准备结果在 `msgKey + ':envelope'` 冻结 24 小时，队列重试直接复用，不重复请求 Slack 或 Agent 配置。
- **目录缓存**：频道画像（`relay:dir:v1:ch:<team>:<channel>`）与用户显示名（`relay:dir:v1:user:<team>:<user>`）在 `ThreadStore` 缓存 24 小时，单次消费通过批量 `MGET` 读取；查询失败自动降级保留原始 ID，永不阻塞任务投递，也不保存邮箱等隐私字段。
- **游标推进与恢复**：仅当 Issue 或评论确认写入 Multica 后才推进 `ThreadState.lastDeliveredTs`。若 Redis 缓存过期或遇到乱序迟到事件，从当前 scoped Issue 描述及 `<!-- relay-message:` 评论回读已持久化的 `messageTs`，选取早于本次请求的最新已交付时间戳作为 `sinceTs`，且不倒退全局最新游标。
- **确定性失败语义**：当前线程读取遇 429 或 5xx 返回可重试错误交由 QStash 重试；明确权限缺失或根消息不存在返回 `context_required_unavailable` 终止重试；单事件准备上限 48 KiB，最终 Markdown 描述上限 64 KiB。
- **本地发送幂等**：`scripts/slack-reply.py` 维持本地 `.slack-reply-state/` 的 `attempting → accepted → sent` 账本；静默收尾（`--clear-start-reaction`）在原触发消息已被发送者删除（`message_not_found`）时视为已无需清理，并继续清理本轮合并/插话（`supplement`）消息上的残留表情与会话状态。
