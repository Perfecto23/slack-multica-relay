# 看板台账与回告

台账是配置中的无人指派任务。追加顶层评论，首行 `<!-- duty-board:v1 -->`，随后一句说明与一个 JSON 代码块（对象或对象数组）。每次写完整新记录，看板按 `(issue,kind)` 取最新；写后回读。旧记录保留。

| kind | 字段 |
|---|---|
| scan | issue、feedbackDate、coverageComplete、collected:{canny,facebook,intercom}、nonBug、productDecision、csFollowed、suspected、outcomes:{confirmed,duplicate,verificationBlocked,excludedAfterInvestigation,skippedFailure} |
| bug | issue、feedbackDate、source、sourceUrl、candidateId、prs:[全部PR链接]、delivery:null 或 {permalink} |
| release | issue、state:"verified"、environment:"production"、verifiedAt（带时区）、evidenceUrl（HTTPS）、prCommits:{PR链接:对应完整merge SHA} |
| notify | issue、state:"sent"或"skipped"、at（真实发送/决定时间）、via、message，跳过另有 reason |
| notify-followup | issue、notifyAt、judgedThrough、csInformedAt、csInformedPartId、respondedAt；Canny 另有 baselineScore、respondedCommentId |

完整分类中 collected=nonBug+productDecision+csFollowed+suspected；suspected=confirmed+duplicate+verificationBlocked+excludedAfterInvestigation+skippedFailure。未知数量用缺失值，避免以 0 替代失败。不同反馈日独立记录；进度可从原任务阶段 metadata 推导。

## 状态依据

- 受阻：dailyBug.state=blocked 且 PR 未全部合并，保留 blocker 和证据，单列统计。
- 待审查：实际 PR 状态为 open；已关闭未合并单列。审查人的 🚫 表示方案不上线，真实已合并事实仍保留。
- 已合并：当前全部关联 PR merged；此时状态为 merged，待核验发布。
- 已上线：全部 PR merged，且 production release 台账包含当前每个 PR 的 merge SHA、时间和证据链接。核验者先在目标环境证明实际部署包含修复（cherry-pick 发布也需保留对应关系），再记录 receipt。看板校验 receipt 与当前 PR 身份/版本，报告的是已登记的发布核验，不自行执行部署探测。
- 回告只在发布核验后进入流程；统计发送回执与客户回应，保持阶段独立。

看板以所属扫描批次归组，过滤指定 dutyAgentId，保留采集、调查、修复阶段与历史日期。HTML 静态正文可读，脚本只增强筛选/搜索/日期切换。缺失扫描索引或 Slack 历史读取错误保留说明；历史日期视图展示生成时最新工程状态。

## 回告与回应

真人在原问题任务要求回告时，先核对真实生产发布，再起草具体内容、接收人和身份。Intercom 起草给对应 CS 的英文消息与必要报告；Canny/Facebook 按授权渠道起草。owner 对精确草稿和目标批准后，使用批准身份发送并回读；结果未知先核对。自行发送的真人应提供真实回执；明确不回告保存 reason。

sent/skipped 记录只在实际发送/决定后追加，at 是回应窗口起点。完成回读后，在有 reaction 授权时为交付根消息加 📤/🔕；reaction 失败保留台账事实，已有表情不重复加。

看板跟踪发送后 14 天。Intercom 新公开 CS 回复先由 Agent 判断是否告知已修复上线，csInformedAt 后的客户消息才算回应。Canny 新公开评论按正文与作者证据判断，票数变化只作参考；judgedThrough 避免重复判断。Facebook 暂无回应统计。未知来源读取留 unread，不推定无回应。

lookups、消息草稿及客户材料放任务私有目录；对外看板只保留问题摘要、判断、链接和状态，移除客户个人资料、账号与查询语句。
