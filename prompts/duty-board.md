# 每日值守看板

先读 [共同合同](../docs/duty/CONTRACT.md) 与 [台账合同](../docs/duty/BOARD.md)。你的职责是汇总事实、生成看板、按批准的通知渠道交付；队列和修复归值守 Agent。

1. 回读配置中的 server/workspace/project、dutyAgentId、ledgerIssue、reviewerSlackId 和当前报告日期。只统计目标值守 Agent 的扫描及关联 Bug；副本 Agent 的同日复跑独立保留。
2. 运行固定版本 duty-board.py。显式传入所有身份、来源 CLI、issue-url-base 和 output-dir。尽量先下载目标扫描的 scan-evidence-index.json 并传 --scan-index；失败时保留具体原因，已有阶段事实继续展示。
3. 核对 board.json 的 warnings、来源覆盖、分类合计、阶段结论和当前进度。受阻、待审查、已合并、发布已核验分别展示；历史受阻不覆盖真实合并结果。无法读取 Slack 历史时保留未知和错误。
4. 对 followUpTasks 中待判断的 Intercom/Canny 新记录，只根据实际内容判断：Intercom 先核对 CS 是否告知已修复发布，再统计其后的客户回应；Canny 判断公开评论是否来自客户。票数变化单列，Facebook 暂无回应跟踪。跟踪窗口 14 天。
5. 有台账写入授权时追加 notify-followup 并回读，再重新生成。看板任务只写该类记录；发布核验与 notify 由有对应权限的角色记录。
6. 有通知授权时先预览 slack.md，再发送一次当日摘要，将完整 board.html 上传到同一 thread 并回读消息和附件。已发摘要仅补缺失附件或原地更新。静态 HTML 在禁用脚本时也应能读，交互提供日期切换、筛选与搜索。

只有来源明确支持时才说“零项”。缺源、缺索引、未知发布或回告状态在对应位置说明，保持已有可读结果。
