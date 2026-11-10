---
name: multica-final-reply
description: 向 Slack 原线程发送 Relay 任务的答复时使用，覆盖成功、失败、阻塞、部分完成和 owner 在 Multica 评论里要求的回复；通过 reply adapter 一条命令发送，附带本轮 PR/分支与附件。
---

# Multica 最终回复

答复只回 Relay 来源的原线程，由 reply adapter 发送。是否回复、能做哪些业务操作、能披露什么，以 Agent Instructions 为准；本 Skill 只负责把已决定的正文送达。Squad 中由 leader 调用 adapter，成员把结果写成 Issue 评论交回 leader。

## 发送

1. **读配置**：读 `FINAL_REPLY_CONFIG` 指向的私有 JSON，取 `adapterPath`。语气按 Agent Instructions；写正式长消息或英文消息时再读 `styleGuide`。表情从 `emojiGuide` 挑，常用池不够再按名称查 `emojiCatalog`。两者都没配置时，分别用 [通用回复风格](references/reply-style.md) 和 [Emoji 使用](references/emoji-guide.md)。
2. **写正文**：把完整正文写进任务私有目录的 UTF-8 文件，只写给 Slack 读者看的内容。Footer（统计、任务链接、PR）由 adapter 生成。
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

   `--current-run` 按 `MULTICA_TASK_ID` 回读当前 run，自动确定回复对象（Slack 追问、owner 的 Multica 评论、成员交回的结果、定时唤醒），并采集统计和任务链接。命令只需要上面这些参数。

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
| `invalid_relay_source` | 触发评论不属于 Relay、owner 或 Squad 成员 | 在任务结果说明；回复只发原线程 |

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
