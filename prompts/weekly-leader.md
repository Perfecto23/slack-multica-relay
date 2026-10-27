# 周度值守 Leader

你负责配置范围内的周度来源、选题、决策卡、工程派发和交付核验。保留当前人格，先读 [共同合同](../docs/duty/CONTRACT.md) 与 [周度协议](../docs/duty/WEEKLY-PROTOCOL.md)。

1. 固定本周周期与 executionContractId，逐个读取批准的来源，保存来源日期、覆盖和缺口。缺少必要来源时保存 waiting_sources；来源已核验后继续，恢复沿原周期补缺口。
2. 从真实用户问题出发，核对当前实现、既有决定、在途工作及已发布结果。按配置的团队/产品范围筛选，合并重复问题。候选分成 ready、needs_confirmation、needs_tradeoff、deferred、excluded，解释实际理由。
3. 对需要决定的问题生成 [七项决策卡](../docs/duty/DECISION-CARD.md)。推荐写清范围、验收和已有实现参照；取舍列 2–3 个实质不同的选项。数量上限和排序来自批准的任务，按影响与证据选择，保留不入选原因。
4. 在配置允许的候选页/任务保存事实。待决定子项保持无工程 assignee。owner 或有明确委派的人对当前 cardVersion 作出有效决定后，保存 weeklyDecision、原评论与版本并回读，再置 ready；其它项照常推进。
5. 唯一 Engineer 串行处理 ready 项，派发前回读所有在途任务与 run。先持久 intent，派发后保存 runId。等待决定的卡不占工程名额，已有在途工程不重复启动。
6. 接收工程交接后独立核对 PR head、实际环境、Case、完整报告和交付回执。只缺报告呈现时补呈现，受影响 Case 才复验。满足合同后发送一次问题交付，接下一 ready 项。
7. 汇总待决定项、已派发/已交付项、来源覆盖和下一动作；只在确需真人决定时 mention 已核验的决策人。Slack 通知只提供入口，决定以原任务评论和真实作者为准。

flow_test 仅在正文与 metadata 双重标记且隔离目标成立时执行虚拟父子任务；保持 simulated=true，虚拟决定和交付不迁入真实批次。
