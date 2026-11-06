---
name: multica-final-reply
description: 在 Multica 的 Slack Relay 任务需要向原线程发送已获授权的最终答复时使用；整理当前 run 统计、任务入口及相关 PR/分支证据，通过确定性 reply adapter 发送。
---

# Multica 最终回复

适用于成功、失败、阻塞和部分完成。是否回复、业务操作权限和资料披露范围遵循当前任务与 Agent Instructions。此 Skill 不授予 GitHub 写入或额外 Slack 发送权限。

## 本次来源与唯一发送方

每次先核对当前 Issue、触发 comment、真实 run 和交付角色。Team 的成员将结果交接给指定发送方，复用同一私有 FINAL_REPLY_CONFIG 与持久 ledger；同一来源已有回执时只补缺失附件。私有 styleGuide/emojiGuide 继续是个人表达真源。

## Owner 在 Multica 中的评论

Relay Issue 上由 owner 本人在 Multica 写的评论（没有 relay 标记）同样是有效请求，包括“回 Slack 说……”“把结果发到原线程”。处理完后照常走回复流程，并加本轮触发的 `--comment-id`。adapter 只在评论作者等于配置的 `ownerMulticaUserId` 时接受这种来源，目的地是该 Issue 的原 Slack 线程，每条评论单独交付。不要回答“只能从 Slack 进”；adapter 返回 `invalid_relay_source` 时如实说明评论作者或 Issue 来源不符合条件。

## 定时唤醒的独立交付

当前 run 来自 Multica 时间 wakeup 时，在同一个 adapter 命令加 `--wakeup-run`。adapter 使用 `MULTICA_TASK_ID` 回读真实 running run、wakeup 规则和原授权来源，生成独立交付标识，目的地仍来自原来源 envelope。同一 run 的重试复用回执；新 run 单独交付。普通 mention、人工重跑、已结束 run 和事件型 wakeup 保持原协议。周期任务的业务去重（例如每天一次）另外按已批准周期核对结果记录，不通过新 run 绕过同周期约束。

## 原生状态

Relay 普通请求自动展示 processing。定时任务开始时可通过 adapter 的 `--session-status processing --wakeup-run` 设置状态；等待真人决定时在询问送达后设置 suspended。最终正文及附件送达后，adapter 尝试设置 active，并避开同一 Issue 的其他活动 run。状态返回 unavailable 表示展示失败，正文回执仍有效。保持同一配置与来源，不用状态错误重发正文。

## 回复流程

1. 读取环境变量 `FINAL_REPLY_CONFIG` 指向的私有 adapter JSON。`adapterPath` 是发送脚本路径，`slackCliPath` 是当前 Runtime 已安装的 Slack Skill CLI；若有 `styleGuide`、`emojiGuide`，读取这些本地文件及其必需参考，分别作为个人语气和常用表情真源。没有指定风格时使用 [通用回复风格](references/reply-style.md)。表情选择见 [Emoji 使用](references/emoji-guide.md)；只有常用池不足时才按名称查询配置中的 `emojiCatalog`，不整份加载。
2. 在当前任务私有目录中执行 `python3 <本 Skill 路径>/scripts/run_context.py --issue <当前 Issue UUID> --output <新的 run-context.json 路径>`。脚本使用已注入的 `MULTICA_TASK_ID`、`MULTICA_WORKSPACE_ID`、`MULTICA_SERVER_URL` 和已认证的 Multica CLI；不改选其他 run，不轮询。`FINAL_REPLY_APP_URL` 与 `FINAL_REPLY_WORKSPACE_SLUG` 为隔离运行提供网页地址和工作区 slug；已有字段也可用 `--issue-identifier`、`--workspace-slug`、`--app-url` 传入。缺失时脚本只读补查，仍无法核实则省略任务链接。
3. 读取采集结果。统计截至采集时刻；`code_evidence` 只是候选。仅选择本轮实际处理且已核验的 PR/分支，排除示例、失败操作和仅讨论的链接。无法唯一配对或截断的日志需要已有业务证据或按当前 GitHub Skill 只读补查；不得据此宣称操作完成。PR Review/复审另读 [PR 回执](references/pr-review-receipt.md)。
4. 有 GitHub 结果时创建任务私有的 `github-context.json`，格式如下。每个 PR 一项，保留对应 head branch；没有 PR 的已核验分支放入 `branches`。合计最多五项，重复结果合并。没有成果时省略整个参数。

```json
{
  "version": 1,
  "pullRequests": [
    {"repository": "owner/repo", "branch": "feature/name", "number": 123, "url": "https://github.com/owner/repo/pull/123"}
  ],
  "branches": []
}
```

5. 如果本轮请求明确要求交付文件，先完整读取 [附件交付](references/attachment-delivery.md)，按其规则将最终文件附到本轮 task 创建的 Multica 评论。没有文件交付时跳过。
6. 阅读 [Footer 展示](references/footer-display.md)，将完整正文写入私有文本文件，通过配置中的 `adapterPath` 一次发送：`python3 <adapterPath> --config <FINAL_REPLY_CONFIG> --issue-id <当前 Issue UUID> --text-file <正文文件> --run-context-file <本次采集文件>`。回复 follow-up 时加本次触发的 `--comment-id`，不要复用首次来源；有已核验 GitHub 结果时加 `--github-context-file`；本轮有已确认附件时加 `--deliver-task-attachments`。原频道与根 thread 从来源 Issue/comment 回读，Agent 不自行指定其他目的地。adapter 在首次 POST 前确认精确根消息存在；附件只取 `source_task_id` 等于当前 `MULTICA_TASK_ID` 的本轮评论，经 `multica attachment download` 下载后交给 `slackCliPath` 的 `files_upload --as user`。收到 `slack_rate_limited` 时按 `retry_after_seconds` 等待后，用相同来源命令重试；持续限流时如实说明尚未送达，不清理 ledger。正文和附件分别维护 receipt；任一结果不明都不能直接重发。

采集失败或输出不可用时省略对应元数据参数，继续发送已获授权的正常正文；不读取遗留输出或其他 run 补值。不要把原始日志、凭据、私有路径或整份配置发到 Slack。配置缺失时回到当前 Runtime 已批准的发送入口，不猜凭据、身份或路由。

## References

| 文件 | 使用时机 |
| --- | --- |
| [通用回复风格](references/reply-style.md) | 未配置个人风格真源时 |
| [Emoji 使用](references/emoji-guide.md) | 选择正文表情时 |
| [PR 回执](references/pr-review-receipt.md) | PR Review/复审任务，包括未完成或写回失败 |
| [Footer 展示](references/footer-display.md) | 发送前核对统计与成果口径 |
| [附件交付](references/attachment-delivery.md) | 本轮请求明确要求交付文件时 |
