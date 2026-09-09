# Footer 展示

reply adapter 根据结构化文件生成 context block 和 fallback text；Agent 不手写 Slack Footer。

- 统计行：`:agent_time: 耗时 · :agent_mdi_robot_outline_muted: 模型 · :agent_tool: N tools · :agent_skill: N skills`。仅展示实际有效字段；缺失及零次 tools/skills 隐藏，不展示 token 或缓存率。
- GitHub 行：`:agent_mdi_github: repo · 分支 · PR #编号`。每个 PR 单独一项，仓库显示时省略 owner，但校验和 URL 使用完整 `owner/repo`。
- `duration_seconds` 截至采集时刻。tools 是采集前已返回日志中的 `tool_use` 数量；skills 是可唯一配对、成功读取且按名称去重的 Skill 数量。它们不代表最终运行结束后的完整总量。
- 模型只接受当前 run 所属 Agent 的配置值，来源必须是 `agent_config`。不能用模型自我介绍、历史快照或示例补值。
- GitHub 信息必须来自当前任务的实际操作证据。仅讨论、失败操作、无法唯一配对、输出截断或文档示例均不展示。
- adapter 始终保留私有配置中的 attribution，并继续负责 source scope、delivery marker、at-most-once ledger 和发送后回读。
