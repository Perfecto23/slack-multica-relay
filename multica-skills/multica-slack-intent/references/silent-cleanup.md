# 静默收尾

本轮判定静默后执行一条命令，清理 Relay 加在触发消息上的启动表情：

```sh
python3 <adapterPath> --config "$FINAL_REPLY_CONFIG" --issue-id <当前 Issue UUID> --current-run --clear-start-reaction
```

`adapterPath` 取自 `FINAL_REPLY_CONFIG`，表情名和添加身份取自其中的 `startReaction`。`--current-run` 自动定位本轮触发消息：只移除该消息上配置身份添加的那个表情，保留根消息、其他人和其他事件的表情，移除后回读确认。Owner 的 Multica 评论和定时唤醒没有启动表情，返回 `not_applicable`，属正常结果。

返回报错或配置缺失时，在当前任务记录原因并保持静默。不发送正文、Footer 或替代表情。
