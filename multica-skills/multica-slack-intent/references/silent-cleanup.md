# 静默收尾

只在本轮已确定静默且主 Prompt 授权清理启动表情时执行。当前任务的 `FINAL_REPLY_CONFIG` 须配置 `startReaction`，其中 `name`、`userId`、`tokenEnv` 来自部署配置。

调用配置中的 `adapterPath`：

```sh
python3 <adapterPath> --config <FINAL_REPLY_CONFIG> --issue-id <当前 Issue UUID> --clear-start-reaction
```

后续消息加本轮 `--comment-id`；只清理来源 envelope 的 `messageTs`，保留根消息与其它事件的 reaction。adapter 核验认证身份与配置一致，读取精确消息，只移除该身份的指定表情，再回读确认；已有清理结果直接复用。可用 `--dry-run` 只读核对目标。

配置或能力缺失时，在当前任务记录缺口并保持静默。结果未知先回读，保留其他人同名表情；静默流程只清理启动表情，不发送正文、Footer 或替代表情。
