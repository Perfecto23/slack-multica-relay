# 附件交付

只在当前 Slack 请求明确要求文件、图片、表格或其他本地产物时使用。附件授权只覆盖来源 Issue/comment 映射的原 Slack thread。

## 准备本轮附件

1. 完成并验证最终文件，保留在当前 task 私有工作目录内。
2. 用一条本轮评论保存最终说明和附件：

```bash
multica issue comment add <当前 Issue UUID> \
  --content-file <最终说明文件> \
  --attachment <最终文件>
```

需要多个文件时重复 `--attachment`。回读返回结果，确认每个附件属于该评论。不要把前一 run、其他 Agent 或历史评论的附件当成本轮产物。

3. 最终回复命令增加 `--deliver-task-attachments`。adapter 只选择 `source_task_id == MULTICA_TASK_ID` 的评论附件；没有本轮附件时在 Slack 正文发送前终止。

## 交付边界

- adapter 先确认来源的精确 Slack 根消息存在；不把无效 `thread_ts` 降级到频道或 DM 根部。
- 每批最多 20 个文件，单文件不超过 25 MiB，总计不超过 100 MiB。
- adapter 用 `multica attachment download` 下载到当前 task 下的临时目录，核对 metadata size，计算 SHA-256，再调用 `slackCliPath`：`files_upload --as user --channel <来源频道> --thread-ts <精确根消息> --file ... --sha256 ...`。
- Slack 上传使用独立 receipt。`sent` 直接复用；`attempting` 表示结果未知，返回 `slack_attachment_delivery_unknown` 并停止，不重复上传。
- Slack Skill 明确返回 `retry_safe: true` 的鉴权、权限或参数拒绝不会保留 `attempting`，修正原因后可重新执行同一命令；不得把这种确定拒绝写成附件可能已送达。
- 正文已送达但附件失败时，如实报告部分交付。Multica 评论附件存在只证明 Multica 保存成功，不证明 Slack 已收到文件。
- 不将本地路径、token、下载 URL 或附件内容写进 Slack 正文。文件敏感性和披露范围仍遵循当前请求与 Agent Instructions。
