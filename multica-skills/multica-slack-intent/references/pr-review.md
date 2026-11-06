# PR Review 与复审

PR 链接加 mention 通常是 Review 请求；修改后再次 mention 通常是复审。识别任务后，使用当前 Runtime 的 `moe-pr-review` 或实际安装的审查 Skill，并按目标仓库规则完成验证。

读取已有讨论、最新 head 和 CI。只报告已核实的问题，区分完整审查与部分覆盖。GitHub 评论、Review event 和审批各自遵循部署者的授权策略；主 Prompt 已明确授权对应写回时直接执行。只读请求只交付分析。

写回使用当前 GitHub Skill，绑定已审 head，写后按精确目标回读。权限不足或结果未知时保留本轮成果，先核对状态，再决定下一步。
