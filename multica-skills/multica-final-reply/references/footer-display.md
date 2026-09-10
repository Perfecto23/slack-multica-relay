# Footer 展示

adapter 从结构化文件生成 context blocks 及等价的 fallback text，Agent 不手写 Footer。

- 统计行展示耗时、配置模型和非零 tools/skills；有已核实的 `issue_identifier`、`issue_url` 时，在同一行末尾追加可点击的 Multica 任务编号。没有统计时也可单独显示任务入口；没有链接时省略，不猜 URL。
- 每个 PR 单独一行：仓库名称、行内代码分支和 PR 链接。显示省略 owner，校验和去重使用完整 `owner/repo`。没有 PR 的已核验分支也可单独显示。
- `duration_seconds` 截至采集时刻，tools 是已返回日志的 tool_use 数量；skills 按读取路径及返回 frontmatter 关联并去重，兼容并行乱序，无法确认的读取省略。它们不代表 run 结束后的最终总量；模型来自 run 所属 Agent 配置，不代表实际计费或执行模型证明。
- 图标默认为标准 Unicode，可通过私有 JSON 的 `icons` 覆盖 time/model/tools/skills/github/multica。workspace 自定义图标和个人 attribution 不写死在公共代码中。
- 有本轮统计时不重复旧 envelope 模型行，始终保留配置的 attribution。source scope、delivery marker、at-most-once ledger 与发送后回读仍由 adapter 负责。
