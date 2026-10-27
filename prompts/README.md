# Agent 工作流模板

这些文件提供可复用的任务协议。部署时保留目标 Agent 现有的 Perfecto 人格、风格、Skill 绑定和权限配置，把对应角色协议组合进私有 Instructions；公开仓库只保存通用协议。目录中的相对链接在 Runtime 必须仍可读取，或在发布 Instructions 时展开所需正文。

| 角色 / 入口 | 文件 |
|---|---|
| Slack 请求路由 | [router.md](router.md) |
| 单个 Bug 调查与交付 | [bug-resolver.md](bug-resolver.md) |
| 每日采集、双工位调查、串行修复 | [daily-duty.md](daily-duty.md) |
| 每日看板 | [duty-board.md](duty-board.md) |
| 周度选题与决策、派发 | [weekly-leader.md](weekly-leader.md) |
| 周度实施与验收 | [weekly-engineer.md](weekly-engineer.md) |
| Team 协作边界 | [weekly-squad.md](weekly-squad.md) |
| 定时任务正文 | [triggers.md](triggers.md) |

首次接入先读 [配置与发布](../docs/duty/SETUP.md)。运行时按角色读取 [共同合同](../docs/duty/CONTRACT.md)，每日状态字段读 [每日协议](../docs/duty/DAILY-PROTOCOL.md)，周度状态字段读 [周度协议](../docs/duty/WEEKLY-PROTOCOL.md)。角色之间按明确交接协作，各自的入口和权限独立。
