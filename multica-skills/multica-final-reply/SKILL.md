---
name: multica-final-reply
description: 在 Multica 的 Slack Relay 任务需要向原线程发送已获授权的最终答复时使用；整理当前 run 统计、任务入口及相关 PR/分支证据，通过确定性 reply adapter 发送。
---

# Multica 最终回复

适用于成功、失败、阻塞和部分完成。是否回复、业务操作权限和资料披露范围遵循当前任务与 Agent Instructions。此 Skill 不授予 GitHub 写入或额外 Slack 发送权限。

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
