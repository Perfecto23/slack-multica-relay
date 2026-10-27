# 定时任务正文

以下是待配置模板，部署时替换每个占位并核对已批准的调度与权限。脚本版本固定为本仓已发布、可回读的完整 SHA；模板本身不创建定时任务。

## 每日扫描

```text
mode=scan
executionPolicy=lane_investigation_serial_repair_v2
schedulerRevision=<OUR_PUBLISHED_40_CHAR_SHA>
读取 DUTY_CONFIG，核对当前 Agent/项目与 daily 配置。
按照 daily-duty 运行：采集目标反馈日 → 完整登记 → 双工位调查 → 汇总 → 串行修复与交付。
沿已有轮次状态恢复；每源日期边界来自批准的时区和周期。
```

## 每日看板

```text
mode=board
schedulerRevision=<OUR_PUBLISHED_40_CHAR_SHA>
读取 DUTY_CONFIG，按 duty-board 生成当日摘要与 HTML，核对实际阶段与 warnings。
按通知授权发送并回读；重复触发只补缺失产物。
```

## 周度值守

```text
mode=delivery
flowVersion=weekly-v5-adapted
period=<APPROVED_PERIOD>
读取 DUTY_CONFIG，按 weekly-leader 核对来源、产出决策卡、串行实施 ready 项并核验交付。
真人决定保存在原问题任务，待决定项不阻塞其他 ready 项。
```
