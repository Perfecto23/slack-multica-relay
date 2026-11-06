# 上游同步与维护边界

本仓独立历史的主线保留为 `Perfecto23/slack-multica-relay`。最近吸收的上游为 [winchesHe/slack-multica-relay](https://github.com/winchesHe/slack-multica-relay)，固定提交 `d0e47f7d05ca246e6ea054f727eed01c49102bb1`（2026-11-05，UTC+8）；本次本仓基线为 `d6cd6e3997ee514a0488b3ce56ba6c902813e9e4`。采用功能移植，保留本仓增强，而不是把两套独立初始化历史合并。

| 上游变化面 | 本仓责任位置与取舍 |
|---|---|
| Team 配置、路由、迁移、取消 | src/config.ts、multica-api.ts、thread-router.ts、cancellation.ts；保留 v5 context、严格 marker 和 workerd redirect 处理 |
| Reaction 诊断 | src/reaction.ts 与路由日志；只输出已知错误码 |
| 最终回复运行资料 | run_context.py：CLI 缺失错误、service_tier；slack-reply.py 同步统计显示并补齐 Team 共享 ledger |
| 每日调度、进度与看板 | scripts/duty-{queue,dispatch,progress,board}.py 及对应上游测试；移除个人部署默认值，合并与上线分开 |
| Router、Resolver、每日值守、看板、周 Leader/Engineer/Team、Autopilot、七项决策卡 | prompts/ 与 docs/duty/；重写入口和按需协议，保留状态/交接能力，身份/风格/授权由私有配置提供 |
| 上游个人回复风格、表情目录、owner 例外、固定通知频道和历史单次恢复授权 | 保留本仓私有 styleGuide/emojiGuide/catalog 入口及有效授权；不引入上游个人配置 |
| 上游一次性迁移 patch、目标 ID 清单、试跑结果与设计草稿 | 属于上游部署历史；本仓接入步骤和当前协议归 docs/duty/，不将旧目标变成当前配置 |
| 上游 README、Setup、Review、Cancel Plan、AGENTS 内容 | 通用操作与恢复合同吸收到本仓现有双语配置/上下文文档及角色协议；本仓 AGENTS 权限和隐私边界维持有效 |
| 上游减少上下文、附件、根消息核验、严格 marker、Buffer 导入及对应测试的差异 | 本仓继续维护这些增强和测试，避免删除已有用户能力 |
| package.json、lockfile、平台入口 | 两个远端基线无依赖或入口升级差异；保持本仓已提交版本 |

## 后续同步

读取上游默认分支与精确 SHA，再比较 `d0e47f7..新SHA`。按上表责任面移植，更新本记录的上游锚点；自己的 main、未提交本地配置及私有 Runtime 分开维护。新增通用能力进入代码/协议，个人指令由当前人格和授权决定。

验证包括 pnpm test、pnpm lint、pnpm build:cf 和 diff/link 检查。源码通过验证后，再按 [发布与验收](duty/SETUP.md) 核对 Relay、Agent/Skill、调度和真实交付，避免把代码同步写成线上启用。

## 已吸收至 2026-11-05

- #73：作者身份查询、Bot 拒绝、入站共享时间预算和失败路径测试；保留本仓全部附件投影及上下文指纹。
- #68：Router 专属意图 Skill 归入本仓；PR 写回遵循本部署授权，静默清理使用本仓 adapter 与配置的身份/表情。
- #67、#71：Resolver 的文件范围与每次 run 资源收尾。
- #65：值守负责人通知协议，按真实归属核验、原交付附带、逐结果去重；默认随工作流停用。
- #69：Slack 摘要移除数据提醒区块，完整 Markdown/HTML 看板仍保留告警。
- #70、#74：保留调度时间与固定发送身份能力，具体时间和 Bot/User actor 来自本部署配置。
- #72：继续遵循本仓与目标仓库的必检与 hooks 合同，不移植上游跳过 hooks 的个人规则。
- #75：值守执行期间本机 Skills、Prompt、工作区配置与 Relay 源文件只读。

以上是源码和模板能力；上线 Agent 的 Instructions/Skill 与计划任务启用分别执行。Luz 的 reaction 与发布后关单方案已核对，后续设计见 [触发与授权](TRIGGER-AUTHORIZATION.md)。
