---
name: multica-final-reply
description: 向 Slack 原线程发送 Relay 任务的答复时使用，覆盖成功、失败、阻塞、部分完成，以及 owner 在 Multica 评论里明确要求发到 Slack 的回复；通过 reply adapter 一条命令发送，附带本轮 PR/分支与附件。
---

# Multica 最终回复

答复只回 Relay 来源的原线程，由 reply adapter 发送。是否回复、能做哪些业务操作、能披露什么，以 Agent Instructions 为准；本 Skill 只负责把已决定的正文送达。触发评论开头是 `<!-- relay-message:` 的，是 Relay 以 owner 账号转来的 Slack 追问，必须用本 Skill 回原线程。owner 亲手写的 Multica 评论默认在 Multica 回答，评论明确要求发到 Slack 时才调用本 Skill。派给其他 Agent 的活，由对方写成 Issue 评论 @ 你交回，再由你调用 adapter 回复。

## 发送

1. **读配置**：读 `FINAL_REPLY_CONFIG` 指向的私有 JSON，取 `adapterPath`。语气按 Agent Instructions；写正式长消息或英文消息时再读 `styleGuide`。表情从 `emojiGuide` 挑，常用池不够再按名称查 `emojiCatalog`。两者都没配置时，分别用 [通用回复风格](references/reply-style.md) 和 [Emoji 使用](references/emoji-guide.md)。
2. **写正文**：把完整正文写进任务私有目录的 UTF-8 文件，只写给 Slack 读者看的内容。用标准 Markdown（`**粗体**`、`[文字](链接)`、列表、表格、代码块），adapter 以 Block Kit markdown block 发送，由 Slack 原生渲染；正文控制在 12000 字以内。Footer（统计、任务链接、PR）由 adapter 生成。
3. **写 GitHub 证据（可选）**：本轮自己用 `gh` 处理并回读过的 PR 或分支，写进 `github-context.json`，最多五项。PR Review/复审另读 [PR 回执](references/pr-review-receipt.md)。

   ```json
   {"version": 1,
    "pullRequests": [{"repository": "owner/repo", "branch": "feature/name", "number": 123, "url": "https://github.com/owner/repo/pull/123"}],
    "branches": []}
   ```

4. **挂附件（可选）**：请求明确要文件时，按 [附件交付](references/attachment-delivery.md) 先把文件挂到本轮 task 的 Multica 评论。
5. **发送**：执行一条命令；有 GitHub 证据加 `--github-context-file <文件>`，有附件加 `--deliver-task-attachments`。

   ```bash
   python3 <adapterPath> --config "$FINAL_REPLY_CONFIG" --issue-id <当前 Issue UUID> --current-run --text-file <正文文件>
   ```

   `--current-run` 按 `MULTICA_TASK_ID` 回读当前 run，自动确定回复对象（Slack 追问、owner 要求发到 Slack 的 Multica 评论、被派单 Agent 交回的结果、定时唤醒），采集统计和任务链接，并在收尾时自动清理本轮及被折叠合并（`coalesced`）或被 Steer 插话（`supplement`）进本轮的排队/等待/离线表情。
   - **长任务原地刷新状态卡（推荐用于耗时 >1 分钟的调查/审查/派单）**：执行 `--current-run --progress "🔍 正在拉取 PR diff 并核对调用链…"`（不带 `--text-file`）。首次调用发送一条斜体进度卡，后续重复调用原地 `chat.update` 刷新同一条消息；发送最终正文（或静默收尾）时，adapter 会**自动删除该临时进度卡再发正式回复**，既保持线程干净，又保留 Slack 新消息通知提醒。
   - **需要保留在线程里的阶段性回复（可选）**：当请求者插话要求“先回我一句结论再继续做”，加 `--interim <步骤名>`（如 `--interim ack`）配合 `--text-file`。阶段性回复保留在线程里且不会锁死本轮最终回复。

完成标准：adapter 返回 `ok: true` 和 `message_ts`；或者按下表处理完错误，并在 Multica 任务结果里写明送达状态。

## 结果

| 返回 | 含义 | 处理 |
| --- | --- | --- |
| `ok: true` + `message_ts` | 已送达 | 完成 |
| `duplicate: true` | 这条来源已经发过 | 完成，保持原消息 |
| `multica_read_failed` | adapter 已自动重试，Multica 仍读不到 | 等 30 秒用同一命令再试一次；仍失败就在任务结果写“未送达：Multica 读取失败” |
| `slack_rate_limited` | Slack 限流 | 等 `retry_after_seconds` 后用同一命令重试；持续限流写明未送达 |
| `reply_delivery_busy` | 同一来源正在另一个进程发送 | 等 10 秒用同一命令重试 |
| `reply_failed_verify_before_retry` | 中途出错，可能已经发出 | 用 `moe-slack` 读原线程：消息已在就算送达；没有就用同一命令重试一次（adapter 的发送记录会挡住重复发送） |
| `slack_delivery_unknown`、`slack_send_unverified`、`slack_attachment_delivery_unknown` | 已发出请求，结果不明；adapter 会锁住这条来源 | 用 `moe-slack` 读原线程：消息已在就算送达；没有就在任务结果写“结果不明，原线程未见消息”，留给本人处理 |
| `invalid_relay_source` | 触发评论不属于 Relay、owner 或被派单的 Agent | 在任务结果说明；回复只发原线程 |

其他错误码照原样写进任务结果。

## 原生状态

Relay 入站时已设为 processing，送达后 adapter 自动复位。正文在请真人做决定时，送达后再执行同一命令，把 `--text-file <正文文件>` 换成 `--session-status suspended`。状态返回 `unavailable` 只影响展示，正文回执照常有效。

## References

| 文件 | 何时读 |
| --- | --- |
| [PR 回执](references/pr-review-receipt.md) | PR Review/复审，包括未完成或写回失败 |
| [附件交付](references/attachment-delivery.md) | 请求明确要文件 |
| [Footer 展示](references/footer-display.md) | 需要解释 footer 统计和成果口径 |
| [通用回复风格](references/reply-style.md)、[Emoji 使用](references/emoji-guide.md) | 私有配置没有风格或表情指南 |
