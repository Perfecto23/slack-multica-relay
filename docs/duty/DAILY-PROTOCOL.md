# 每日调查与修复协议

脚本真源为 `scripts/duty-queue.py`、`duty-dispatch.py`、`duty-progress.py`。新轮使用 `protocolVersion=2`、`lane_investigation_serial_repair_v2`；固定完整 schedulerRevision。旧轮沿其固定版本恢复，升级须有该轮的明确决定。

## 1. 扫描与固定清单

新扫描先回读身份与 mode，再初始化并回读：

```json
{
  "dailyExecution": {"schemaVersion":1,"policy":"lane_investigation_serial_repair_v2","laneCount":2,"repairConcurrency":1,"investigationFailurePolicy":"retry_2_then_skip_v1","schedulerRevision":"<完整提交SHA>","runtimeId":"<当前Runtime>"},
  "dailyBatch": {"mode":"scan","state":"scanning","bugIds":[],"index":0,"total":0,"currentIssueId":null,"deliveryVersion":0,"advancePolicy":"after_verified_delivery","deliveredBugIds":[],"completedDeliveries":[]},
  "dailyRound": {"schemaVersion":1,"policy":"investigate_all_then_repair","state":"collecting","registrationComplete":false,"investigationComplete":false}
}
```

先保存 dailyExecution，再创建 dailyRound；已有状态保留并按阶段恢复。dailyScan 保存 targetDate、每源 sources 回执、collected、coverageComplete 和 counts；每来源完成后立即更新，失败数量保持未知。目标日一经保存固定不变。补读窗口从该来源最后成功日期次日到目标日，仅在工作流已批准补采时执行；默认单日，历史积压单独授权。

采集器通过配置的绝对路径调用，使用同根 Skill 和实际 `--help`。环境变量只检查名称和存在性；Canny 的已授权 account-ref 用参数数组传入。客户邮箱/电话维持脱敏；原附件按采集器保留策略处理。逐条补证不更新日采集进度。

初筛按来源稳定 ID 归并，保留来源链接、原反馈日、采集 runId、现象、预期依据和候选摘要。明确在途工单/PR只关联，产品取舍、非 Bug分别分类。固定清单上传后下载核对真实字节；candidateSetSha256 用排序后的唯一 candidateId JSON 数组计算（UTF-8、ensure_ascii=False、separators=(',', ':')）。

dailyRound 增加 candidateCount、candidateSetSha256、candidateManifest={attachmentId,sha256,readbackHashVerified:true}，state=registering。原扫描由当前 Agent 追加清单评论：

````text
<!-- daily-round-manifest:v3 round=<扫描UUID> -->
本轮冻结候选
```json
{"roundId":"<扫描UUID>","candidates":[{"candidateId":"<稳定ID>","feedbackDate":"YYYY-MM-DD","summary":"具体问题"}]}
```
````

回读数量和摘要后，创建两张初始无 assignee 的子工位，真实 parent 为原扫描。首行 mode=investigate_lane，标记 `<!-- daily-investigation-lane:v3 round=<扫描UUID> lane=<1或2> -->`；dailyLane={schemaVersion:1,mode:"investigate_lane",roundId,lane:1或2,laneCount:2,state:"ready",currentCandidateId:null}。回读两卡后设置 dailyRound.investigationStore=lane_comments、laneIssueIds、registrationComplete=true、state=investigating。候选零项仍须完整清单/登记回读。

metadata 控制在 8 KiB 内，长材料放附件。创建结果未知按 marker 和真实父子关系恢复。登记完成前保持未完成状态，冻结后新反馈留给下一轮。

## 2. 工位调查与结论

plan 返回 investigate_candidate 后只处理该 candidateId。每工位使用独立 worktree、证据目录、浏览器 tab 和测试数据。工位只写自己的结果，父扫描拥有汇总、分类和修复清单。

结论追加到所属工位评论，由当前值守 Agent 写入，第一行 `<!-- daily-investigation:v3 round=<扫描UUID> candidate=<candidateId> -->`，后面一句说明与一个 JSON 代码块。JSON 字段为：

- schemaVersion=1、mode=investigate、roundId、sourceScanId=roundId、laneIssueId、candidateId、feedbackDate、state、evidenceRevision、nextAction。
- investigationRecord={attachmentId,sha256,readbackHashVerified:true,evidenceRevision}，对应本次报告实际下载核验；证据版本一致后才认可。
- confirmed：verification={fixable:true,productDecisionRequired:false,expectedBehaviorRef,observedDeviationRef,dedupeRef}，三项均为真实证据引用。
- duplicate / excluded / cs_followed：conclusionRef 为重复工作、排除理由或已核对工单的引用。
- suspended_external：blocker={kind:"external_evidence",missingEvidence,resumeCondition,attempts:{source,implementation,data,verification},evidenceRevision,checkedAt,nextCheckAt}。四条路径都有实际尝试或不适用说明，nextCheckAt 至少晚于 checkedAt 24 小时。
- ready / investigating 且可恢复故障：保存 executionFailure={kind,error}、现有报告、动作和 nextAction，回读后 advance。调度器负责首次加最多两次重试。
- skipped_failure 由调度器追加，包含 failureSkip={retryLimit:2,runIds:[三次不同真实run],reason,resumeCondition,skippedAt}。它只证明失败已留档，保持独立分类；不进入本轮修复。

同一候选以本 Agent 最新完整记录为准；后续 waiting_repair、delivered 和 repairIssueId 继续追加，保留历史。结果未知先回读，不通过清零次数或另建候选重试。归属/版本冲突、未知启动、人工取消保留现场并报告。

## 3. 调度器

从本轮固定的本仓版本导出 duty-dispatch.py 和 duty-queue.py 到同一 Runtime 目录；同 Runtime 全部工位共享 `~/.config/moego/daily-bug-duty/dispatch/<workspace>/<agent>/` 的锁与 journal。它是本机协调，部署须将同一队列约束在单一 Runtime/共享文件系统。Agent 并发配置由部署时明确设置为 2，脚本不修改该配置。

```text
python3 <目录>/duty-dispatch.py plan|advance
  --server-url <server> --workspace-id <workspace> --project-id <project>
  --agent-id <agent> --runtime-id <runtime> --revision <固定SHA>
  --round-id <扫描UUID> --current-issue <当前Issue> --current-run <当前run>
```

以上折行为参数说明；实际使用参数数组执行。plan 只读且没有启动回执；advance 执行获授权调度。新扫描完整登记后 advance；工位开工 plan，结果回读后 advance。

| 返回动作 | 当前运行行为 |
|---|---|
| register_round | 留在父扫描补齐登记 |
| investigate_candidate | 只调查指定候选，回读结论后 advance |
| settle_failure | 只调用 advance 留档并接续，保持失败事实 |
| dispatch | 核对真实 receipts 后退出，释放名额 |
| finalize_round | 原扫描汇总后继已排入/复用；当前运行退出 |
| yield_to_finalizer | 已有汇总后继，当前运行退出 |
| finalize_round_here | 父扫描是唯一活动运行；核对结论并汇总 |
| attention / 非零退出 | 保留 intent、错误和恢复条件，先核对现场 |

最后一个工位退出前会交接汇总后继，汇总运行只有在工位均退出后才完成汇总。当前候选失败后按有界重试继续；无活动运行的工位仅在真人明确恢复该轮时用 recover（同上参数，省略 current-run）。recover 沿原清单和 journal，未知启动先按真实 run 差集核对。

## 4. 汇总与串行修复

所有固定候选均有有效结论或失败跳过记录后，父扫描生成 scan-evidence-index.json 和完整调查索引，上传/下载核对；dailyRound.investigationIndex={attachmentId,sha256,readbackHashVerified:true}、investigationComplete=true、state=ready_repair。索引明确 pending=0、跳过数、外部缺证数；含失败项的轮次用相应结果描述。

修复只取 confirmed 项。调用同版本 duty-queue.py，参数为 --server-url、--workspace-id、--project、--agent、--current-issue、--round-id；--snapshot 可对脱敏 issues/runs 离线规划。核对 protocolVersion=2。

- collect_sources / register_round：补当前轮次缺口。
- investigate_lanes / investigate：使用该轮调度器执行调查，先完成整轮。
- finalize_round：先完成索引和汇总回读。
- wait_repair_slot：其它真实修复队列在途，保留 ready_repair 并退出。
- prepare_round_repair：按冻结 confirmed 集合创建唯一修复清单。
- resume_repair / reconcile_repair：按原队列恢复，保留已交付游标。
- advance_after_block：受阻通知已有回读，推进到返回的 nextIssueId 或收尾。
- complete_round：核对所有完整交付或受阻回执后结束；各状态分别计数。
- wait / idle：保存当前状态，释放运行。
- attention：说明真实矛盾与恢复条件。

Bug 是扫描的真实子任务；dailyBug={mode:"bug",batchId,index,total,candidateId,investigationIssueId,state}。工位调查 ID 为 `<扫描UUID>:<candidateId>`。稳定建卡标记 `<!-- daily-round-bug:v1 round=<扫描UUID> investigation=<调查ID> -->`。全部子项回读后，dailyBatch 固定 bugIds、index=1、total、currentIssueId、state=running；dailyRound.state=repairing。原调查追加 waiting_repair 与 repairIssueId。只启动当前项，回读 run 后退出。

## 5. 交付、受阻、接续

完整交付按共同合同核验代码、必要动态 Case、报告、正文和附件；dailyBug.state=delivered、completeDelivery=true、正整数 deliveryVersion。父 completedDeliveries 追加 {issueId,deliveryVersion,pr,prHead,report:{multicaAttachmentId,sha256,readbackHashVerified:true},delivery:{permalink,readbackVerified:true}}；跨仓 PR/版本和 Case 细节放报告，receipt 的 pr/prHead 绑定主交付。所有关联仓库实际验收齐全后才记 completeDelivery。

真实阻塞保存 dailyBug.state=blocked、blocker={kind,reason,resumeCondition,phase,affectedCaseIds,nextAction}，交付受阻消息并回读；父 blockNotices 追加 {issueId,permalink,readbackVerified:true,kind,at}，blockedBugIds 记录该项。计划器允许接续后再推进 index/currentIssueId；受阻项保持未交付，原 PR/证据保留。

当前项完整交付或受阻通知核验后，按固定顺序推进；每次派发保存 intent、回读真实 runId、写 receipt，再退出。最后一项完成后结束批次和轮次；含受阻结果写 outcome=finished_with_blocked。有等待修复名额的轮次时，按当前身份调用 duty-dispatch.py release-repair 交接，仍核对真实回执。

解除受阻仅凭有权真人的明确决定，复用原任务/分支/PR，从 blocker 指定位置恢复。完成后移出 blockedBugIds、补 deliveredBugIds/completedDeliveries；保持主队列游标不回退。人工跳过留原决定和未完成事实。停止/取消任务保留现场。

## 6. 台账与回告

字段、发布核验和回告规则见 [BOARD.md](BOARD.md)。台账缺口保存在当前任务供补写，不阻塞已有有效工程结果；看板只读汇总，不驱动队列。普通 Slack 回复能否唤醒任务依实际集成核验，任务评论作为真人决定入口。
