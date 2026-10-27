# 值守配置与发布

本仓提供代码、角色模板和状态协议。Relay 路由、Agent Instructions/Skill、值守调度、通知四个部署面分别验收。部署动作按当前目标授权执行；复制文件只完成源码准备。

## 私有配置

`DUTY_CONFIG` 指向 Runtime 私有 JSON。以下为字段示例，替换值必须经实际回读。配置不放 token；认证使用现有凭据存储。来源范围、调度和写入权限用有效授权记录标识，避免把模板当默认授权。

```json
{
  "serverUrl":"https://multica.example.com",
  "workspaceId":"<workspace UUID>",
  "ownerUserId":"<有权决定的 Multica user UUID>",
  "reviewerSlackId":"<审查人 Slack ID>",
  "runtimeId":"<runtime UUID>",
  "sourceRepository":"<本仓只读 checkout 绝对路径>",
  "schedulerRevision":"<本仓已发布的完整 SHA>",
  "authorizationRef":"<已批准范围的记录>",
  "notification":{"channelId":"<批准频道>","actor":"<批准身份>"},
  "daily":{"projectId":"<daily project>","agentId":"<duty Agent>","boardAgentId":"<board Agent>","ledgerIssue":"<无人指派台账>","boardIssue":"<看板任务>","startDate":"YYYY-MM-DD","timezone":"Asia/Singapore","sources":["canny","facebook","intercom"]},
  "weekly":{"projectId":"<weekly project>","squadId":"<Team>","leaderAgentId":"<Leader>","engineerAgentId":"<Engineer>","sources":[],"scope":"<批准的产品范围>","candidatePage":"<批准的候选页或省略>","maxItems":5},
  "tools":{"slackCli":"<Slack CLI绝对路径>","intercomCli":"<Intercom CLI绝对路径>","collectorCli":"<采集器绝对路径>"},
  "issueUrlBase":"https://multica.example.com/<workspace-slug>/issues/",
  "outputRoot":"<私有产物目录>"
}
```

值守是已有能力编排。当前脚本支持 Canny/Facebook/Intercom 三源合同；启用前确认采集器与来源工具确实已安装、认证且参数兼容。脚本适配的来源 CLI 合同由 `--help`、源代码和测试约束，当前 Runtime 路径需显式配置。日期显示默认 UTC+8（Asia/Shanghai 与 Asia/Singapore 同偏移）；其它时区需单独适配脚本与采集口径。

每日新工位轮次需要 Agent max_concurrent_tasks=2；同一调度域固定一个 Runtime，共享本机 journal。周度 Engineer 并发为 1。设定时核对现有轮次，旧轮保持固定版本和并发合同。脚本支持历史逐条调查恢复，模板只初始化新工位协议。

## 看板调用

```text
python3 scripts/duty-board.py
  --server-url <serverUrl> --workspace-id <workspaceId>
  --project <daily.projectId> --duty-agent <daily.agentId>
  --ledger-issue <daily.ledgerIssue> --reviewer <reviewerSlackId>
  --start <daily.startDate> --today <报告日期>
  --slack-cli <tools.slackCli> --intercom-cli <tools.intercomCli>
  --collector-cli <tools.collectorCli> --issue-url-base <issueUrlBase>
  --output-dir <本轮私有目录> --scan-index <已下载索引>
```

折行为参数说明；实际调用用参数数组。Canny 采集器需要已授权账号引用时附 --canny-account-ref。结果为 board.json、board.md、slack.md、board.html；脚本只读来源，通知与台账写入由相应角色按授权执行。

## 发布与验收顺序

1. 固定本仓已经验证的 commit，回读 scripts 与 prompts 全部文件；变更覆盖清单见 [上游同步](../UPSTREAM.md)。
2. 核对现有 Agent 的私有 Instructions/风格/Skill 绑定，再组合相应角色协议。模板不替换人格；个人姓名、签名、表情库、凭据和历史一次性授权保留在私有环境。
3. 对每个角色按 ID 更新并回读 Instructions 与 Skill 文件/绑定；确认相对引用在 Runtime 可读。此阶段只证明配置保存。
4. 若需要 Team 路由，按 [Relay 配置](../CONFIGURATION.md#agent--team-路由) 同步 Relay 与唯一回复 adapter 的作用域，保留旧线程 marker 和 ledger。
5. 用批准的隔离项目执行模拟调查、两工位交接、失败跳过、修复串行和恢复测试；核对真实运行/结果，保持外部业务写入隔离。离线单元测试之外的验收记录另保存。
6. 再创建/更新已批准的 Autopilot，正文取 [triggers](../../prompts/triggers.md)，固定本仓 SHA。每日扫描/看板/周任务的时区、时间和接收人由本部署决定。
7. 首轮真实任务分别核验来源覆盖、工位报告、队列回执、PR/验收、Slack 正文与附件；发布状态用实际环境证据，保持 merge 与上线分开。

恢复时使用轮次固定版本、原 journal 和任务状态。源码回退不清理幂等数据；进行中轮次与新轮升级分别处理。
