---
name: multica-final-reply
description: 在 Perfecto Assistant 需要向 Slack Relay 原线程发送已获授权的最终答复时使用；只读整理当前运行统计和相关 GitHub PR/分支证据，并通过既有确定性 reply adapter 发送。
---

# Multica 最终回复

仅供 Perfecto Assistant 的 Slack Relay 任务使用。本轮需要向原线程发送最终答复时调用，包括成功、失败、阻塞和部分完成。此 Skill 只组织回复资料；是否执行外部动作、是否披露资料以及是否回复，继续遵循 Agent Instructions、`runtime/KNOWLEDGE.md` 和当前授权。

## 回复流程

1. 按 `runtime/SKILLS.md` 读取 `perf-communication-style` 作为正文风格真源，并读取当前任务需要的 Slack、GitHub 或其他专项 Skill，完成业务任务并核实结果。只引用维护中的本地风格 Skill，不把私人风格内容复制进本公开 Skill。
2. 执行 `python3 <本 Skill 路径>/scripts/run_context.py --issue <当前 Issue UUID> --output <任务私有目录/run-context.json>`。脚本使用真实 `MULTICA_TASK_ID` 和当前 Runtime 已认证的 `multica` CLI，只读取当前 run、所属 Agent 配置和 run messages；不选择其他 run，也不等待日志补齐。
3. 读取 `run-context.json`。`statistics` 可直接交给 reply adapter；`code_evidence` 只是候选。根据当前业务任务选择实际相关且已成功的 PR，排除示例、仅讨论内容、失败命令、无法唯一配对或已截断的结果。必要时按 `moe-github-workflow` 只读补查。
4. 有可核验 PR 时，在任务私有目录创建 `github-context.json`：

```json
{
  "version": 1,
  "pullRequests": [
    {
      "repository": "owner/repo",
      "branch": "feature/name",
      "number": 123,
      "url": "https://github.com/owner/repo/pull/123"
    }
  ]
}
```

每个 PR 单独一项，最多五项，按 URL 去重。`repository` 使用完整 `owner/repo`；`branch` 和 PR 必须来自同一实际成果。没有可核验 PR 时不创建或不传这个文件，不用空值占位。
5. 阅读 [Footer 展示](references/footer-display.md)，然后按 `runtime/SKILLS.md` 的 Relay 发送命令一次发送正文，并附加 `--run-context-file <run-context.json>`；存在已核验 PR 时再附加 `--github-context-file <github-context.json>`。发送结果不明时遵循 adapter 的 readback 和 at-most-once 规则，不能直接重发。

采集失败不阻断已经获授权的最终答复。此时省略 `--run-context-file` 和无法核验的 GitHub 信息，继续使用既有 adapter 发送正文；不读取其他 run 或遗留文件补值。运行记录不进入 Slack 正文，不发送原始日志、凭据、私有路径或完整工具输出。

## References

| 文件 | 内容 | 读取时机 |
| --- | --- | --- |
| [Footer 展示](references/footer-display.md) | 统计、GitHub 行、缺失字段及证据口径 | 每次组装最终回复前 |
