# Multica 操作说明

[English](MULTICA-OPERATIONS_EN.md) | **简体中文**

本文件用于操作与 Slack Relay 关联的 live Multica Workspace、Agent、Project、Issue、run、Skill 和 Runtime。普通代码修改不需要加载本文件。

## 固定目标

1. 先运行 `multica --help` 和目标子命令 `--help`，以本机安装版本为准。
2. 通过 `list/get` 核对完整 UUID、Workspace 和关联对象；当前目录、同名对象或旧聊天记录不能替代身份核对。
3. 每次调用显式传入已核对的 `--workspace-id`。使用 `--server-url` 或 `--profile` 时整轮保持一致，不为单次任务修改全局默认配置。
4. 结构化读取使用 `--output json`；完整列表按响应支持的 cursor、`has_more` 或 offset 分页，不解析表格中的截断 ID，也不把 stderr 混入 JSON。

CLI 缺失、认证失败或能力不足时先定位原因。浏览器不作为默认配置入口。

## 常用读取

| 目的 | 命令（补上已核对的 Workspace 参数） |
| --- | --- |
| Agent | `agent list` / `agent get <id>` |
| Project | `project list` / `project get <id>` |
| Issue | `issue list` / `issue get <id>` / `issue search <query>` |
| 执行记录 | `issue runs <issue-id>` |
| 某次执行的消息 | `issue run-messages <task-id>` |
| Runtime | `runtime list` |
| Agent、Skill、Workspace 配置 | 读取对应子命令 `--help` 后使用当前 CLI 支持的命令 |

Issue 是任务卡，run 是一次执行；`run-messages` 接收该次执行的 task ID。Agent 名称字段为 `name`，Project 使用 `title`。

## 更新 Agent 配置

1. 用 `agent get` 锁定当前 Agent 和完整配置，只更新已授权字段。
2. `--instructions` 替换整份内容。完整候选保存在仓库外，并保留本次范围未涉及的现行规则。
3. 多行内容使用程序参数数组传给 CLI，不拼接 shell 命令；凭据不得进入 instructions 或 argv。
4. 更新后按相同 server、Workspace 和 Agent ID 回读目标字段。结果不明时先核对现状，不重复写入。
5. Skill binding 变更回读完整绑定列表；model、reasoning effort 和 service tier 必须与目标 Runtime 支持范围一致。

配置保存、deployment ready、Issue/comment persisted、Agent completed 和 Slack reply delivered 是不同状态。只读验证不触发 Agent task。
