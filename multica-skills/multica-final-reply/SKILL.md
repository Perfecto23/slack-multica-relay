---
name: multica-final-reply
description: 在 Multica 的 Slack Relay 任务需要向原线程发送已获授权的最终答复时使用；整理当前 run 统计、任务入口及相关 PR/分支证据，通过确定性 reply adapter 发送。
---

# Multica 最终回复

适用于成功、失败、阻塞和部分完成。是否回复、业务操作权限和资料披露范围遵循当前任务与 Agent Instructions。此 Skill 不授予 GitHub 写入或额外 Slack 发送权限。Team 中只有指定发送方调用 adapter，其他成员把结果交给它。

## 发送

1. 读取 `FINAL_REPLY_CONFIG` 指向的私有 JSON，取 `adapterPath`。有 `styleGuide`、`emojiGuide` 时按它们写正文和挑表情；没有时用 [通用回复风格](references/reply-style.md) 和 [Emoji 使用](references/emoji-guide.md)。`emojiCatalog` 只在常用池不够时按名称查。
2. 把完整正文写进任务私有目录的 UTF-8 文件。正文只写给读者看的内容，不写工具参数、本地路径或 Skill 名。
3. 本轮实际处理并已核验 PR 或分支时（来自本轮自己的 `gh` 结果或 PR 回读），写 `github-context.json`（格式见下），最多五项；只讨论过的链接、示例和失败操作不算。PR Review/复审另读 [PR 回执](references/pr-review-receipt.md)。
4. 本轮明确要求交付文件时，先按 [附件交付](references/attachment-delivery.md) 把文件附到本轮 task 的 Multica 评论。
5. 执行一条命令：

```bash
python3 <adapterPath> --config "$FINAL_REPLY_CONFIG" --issue-id <当前 Issue UUID> --current-run --text-file <正文文件>
```

有 GitHub 结果加 `--github-context-file <文件>`，有附件加 `--deliver-task-attachments`。

`--current-run` 用 `MULTICA_TASK_ID` 回读当前 run，自动决定：回哪条触发评论（Slack 追问或 owner 在 Multica 写的评论）、是不是定时唤醒的新一次交付，并采集运行统计和任务链接。不要再手填 `--comment-id`、`--wakeup-run` 或 `--run-context-file`。统计采集失败时 adapter 省略统计行，正文照常发送。

```json
{
  "version": 1,
  "pullRequests": [
    {"repository": "owner/repo", "branch": "feature/name", "number": 123, "url": "https://github.com/owner/repo/pull/123"}
  ],
  "branches": []
}
```

## 结果

- `ok: true` 且有 `message_ts` 才算送达；`duplicate: true` 表示这条来源已经发过，不要换参数重发。
- `slack_rate_limited`：等 `retry_after_seconds` 后用同一命令重试；一直限流就如实说明尚未送达。
- `slack_delivery_unknown`、`slack_send_unverified`、`slack_attachment_delivery_unknown`：结果不明，先在原线程核对，不能直接重发。
- `invalid_relay_source`：这条触发既不是 Relay 消息，也不是 owner 本人的 Multica 评论，如实说明，不改发别处。
- Owner 在 Multica 里写的评论（例如“回 Slack 说……”）是有效请求，照常发送；不要回答“只能从 Slack 进”。

## 原生状态

Relay 入站已自动设置 processing，送达后 adapter 自动复位。等待真人决定时，询问送达后执行 `--current-run --session-status suspended`；定时任务开始时可设 `processing`。状态返回 `unavailable` 只表示展示失败，不影响正文回执。

## References

| 文件 | 使用时机 |
| --- | --- |
| [通用回复风格](references/reply-style.md) | 未配置个人风格真源时 |
| [Emoji 使用](references/emoji-guide.md) | 选择正文表情时 |
| [PR 回执](references/pr-review-receipt.md) | PR Review/复审任务，包括未完成或写回失败 |
| [Footer 展示](references/footer-display.md) | 需要解释 footer 中统计与成果口径时 |
| [附件交付](references/attachment-delivery.md) | 本轮请求明确要求交付文件时 |
