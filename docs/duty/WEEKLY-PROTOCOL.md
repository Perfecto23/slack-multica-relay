# 周度状态与交接

新批次 `flowVersion=weekly-v5-adapted`。已有任务保留原合同，显式迁移前继续固定版本。

## 最小状态

- 父任务 `weeklyFlow={mode,flowVersion,executionContractId,selectedIssueIds,activeChildId,deliveredIssueIds,pendingDecisionIssueIds,dispatchReceipts,state}`。
- 子任务 `weeklyItem={mode,candidateId,batchId,index,total,state,cardType,decisionVersion,resultVersion}`；cardType 为 none/confirm/tradeoff。
- `weeklyDecision={cardVersion,decisionVersion,state,authorId,commentId,chosenOption,rationale,scope,outOfScope,acceptanceCriteria,designReferences,appliedAt}`；保存 acceptedCommentIds 和 decisionApplied。相同评论/版本再次触发只回读。
- 候选完整材料、决定原文和长报告留在正文/评论/附件；metadata 控制在 8 KiB 内，保留去重与恢复字段。

## 顺序与完成门槛

1. 原周期来源读取完成 → 按真实问题查重、选题 → 保存候选页和问题任务。已有页面的人工选择维持原状；配置没有页面写入权限时保存在当前任务。
2. ready 项直接进入工程队列；needs_decision 等待真实作者对当前版本的决定。已授权范围明确后才创建/关联实施 Jira；真实 Jira key 与 Multica 编号分开。
3. 派发前分页核对整个 Team 的 queued/dispatched/running/waiting_local_directory。先写父 activeChildId 与子 dispatching，再 assign，回读 runId，保存 receipt。运行仍在途时释放本次 Leader run，等交接。
4. Engineer 交接写子任务再父任务；稳定身份为 executionContractId + candidateId + childIssueId + resultVersion。ready 交接由 Leader 核验实际代码/PR head、构建环境、Case、完整 HTML及附件回读；partial 或缺证继续原任务补齐。
5. 正文与附件交付都回读后保存 delivered/resultVersion，清空 activeChildId 并派发下一 ready 项。正常交付不逐项再等批准。仅余待决定项进入 waiting_decisions；全部项交付、拒绝、暂缓或明确停止后 completed，分别保留结论。
6. duty-decision-needed 只暂停该项。duty-result-blocked 根据具体原因恢复或交给真人；只有原工程运行确已结束且该项按合同释放，才能调度下一项。已有 PR 和证据保留。
7. 后续决定变更保留历史、增加版本、核对影响后在原任务返工；取消/暂停优先于自动接续。通知失败保存 notification_pending，回读去重后补发。

## 流程测试

正文与 metadata 均为 flow_test 且目标为隔离项目时，使用准备好的虚拟父子任务。模拟决定标 simulated=true，工程交接使用 duty-result-ready-test；测试只核对任务调度和去重，保持真实客户、代码、Jira、Slack、发布等写入隔离。完成记录 outcome=flow_test_completed 与实际断言。
