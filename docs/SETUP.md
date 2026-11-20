# 从零搭建

本文带你从一个空的 Slack App 走到“在 Slack 里 @ 你，你的 Multica Agent 在原线程回复”。变量的完整含义和信任边界见 [配置说明](CONFIGURATION.md)，本文只写搭建顺序和每个值从哪里拿。

想让 Agent 带你搭：把 [AGENT-SETUP.md](AGENT-SETUP.md) 交给它，它会先盘点电脑上能用的浏览器和命令行，再一步步带你做，需要你出手时会说清楚。

第 1–5 步都在网页里完成，用哪个浏览器都行，不需要命令行。第 6 步配置 Agent 的本机 Runtime，需要终端。

## 准备

- Slack 工作区成员账号。工作区不允许成员直接安装 App 时，需要管理员批准一次。
- GitHub 账号，用来 fork 本仓库。
- Cloudflare 账号，免费套餐就够。Relay 部署在 Cloudflare Workers 上，从 GitHub 导入即可，不用装 Wrangler。
- Upstash 账号，可以直接用 GitHub 登录，提供 Redis 和 QStash，免费额度够个人使用。
- Multica 账号，以及一台登录了 Multica CLI、绑定了 Agent Runtime 的电脑。

整条链路是：Slack 事件 → Cloudflare Workers 上的 Relay → QStash 队列 → Multica Issue → 你的 Agent → Agent 用你的 user token 回复原线程。

## 1. 用 manifest 创建 Slack App

1. 打开 <https://api.slack.com/apps>，点 **Create New App** → **From a manifest**，选择工作区。
2. 粘贴 [slack-app-manifest.json](slack-app-manifest.json) 的内容，把 `My Agent` 改成你的 Agent 名字，再点 **Create**。

已经建好 App 的，打开 App 设置页左侧的 **App Manifest**，按上面的文件替换 `oauth_config.scopes`，保存。安装前改 scope 不需要任何人批准。

这份 manifest 只申请 User scope，Relay 和 Agent 都用你的身份工作。私聊只有两个真人在场，App 的 Bot 身份进不去，加不了 👀，也读不到上下文。Relay 和回复链路用到的权限如下：

| 身份 | scope | 用途 |
| --- | --- | --- |
| User | `channels:history` `groups:history` `im:history` `mpim:history` | 接收你所在会话的消息事件，读取线程上下文 |
| User | `users:read` | 判断消息作者是不是真人，补充参与者姓名 |
| User | `chat:write` | Agent 以你的身份在原线程回复 |
| User | `reactions:read` `reactions:write` | 收到任务时加 👀，回复后清掉 |
| User | `files:read` `files:write` | Agent 读取消息里的附件、在回复里上传文件 |

事件订阅这一步先不配。Slack 保存事件订阅时会立刻验证回调地址，要等第 4 步 Relay 部署好以后再加。

如果你的 Agent 还要搜索 Slack、读频道列表、管理提醒，在 User scope 里按需追加，例如 `search:read`、`channels:read`。每多一项，管理员审批时要看的内容就多一项。

## 2. 安装 App，拿到 token

1. App 设置页 → **OAuth & Permissions** → **Install to Workspace**。
2. 如果按钮显示 **Request to Install**，说明工作区需要管理员审批：写一句用途后提交，等管理员在 Slack 里批准。批准后回到这个页面，完成安装。
3. 安装完成后，这个页面会显示 **User OAuth Token**，`xoxp-` 开头。
4. App 设置页 → **Basic Information** → **App Credentials** → **Signing Secret**。

等审批的同时可以先做第 3 步，做到 `/api/health` 能打开为止，两个 `xoxp-` 变量先空着。批下来后补上这两个 Secret，再做第 4 步：Request URL 验证时 Relay 会加载全部必填变量，缺一个都验证不过。

这两个值只填进 Worker 的 Secret 和第 6 步的 Runtime 环境，不贴进聊天、Issue 或 Git。安装后再增加 scope，要重新安装一次，可能还要再审批一次，所以 scope 尽量一次勾全。

## 3. 部署到 Cloudflare Workers

1. 在 GitHub 上 fork 本仓库。
2. 打开 <https://console.upstash.com>：
   - **Redis** → **Create Database**，建好后在 **REST API** 区域复制 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`；
   - **QStash** 页面复制 `QSTASH_TOKEN`、`QSTASH_CURRENT_SIGNING_KEY` 和 `QSTASH_NEXT_SIGNING_KEY`。
3. 打开 Cloudflare 控制台 → **Workers & Pages** → **Create** → **Import a repository**，连接 GitHub 并选择你的 fork。Worker 名称填 `slack-multica-relay`，和仓库 `wrangler.jsonc` 里的 `name` 一致；想用别的名字，先在 fork 里改 `wrangler.jsonc`。其余保持默认，点 **Deploy**。这次部署还没有任何变量，接口报错是正常的。
4. 进入这个 Worker → **Settings** → **Variables and Secrets**，按下表逐个 **Add**，类型全部选 **Secret**。普通文本变量会在下一次从 GitHub 部署时被清掉，Secret 会一直保留。

| 变量 | 填什么 | 从哪里拿 |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | Signing Secret | 第 2 步 |
| `SLACK_USER_TOKEN` | `xoxp-…` | 第 2 步，用于作者查询和 👀 |
| `SLACK_CONTEXT_TOKEN` | 同一个 `xoxp-…` | 第 2 步，用于读取线程上下文 |
| `SLACK_TEAM_ID` | `T` 开头的工作区 ID | 网页版 Slack 地址 `app.slack.com/client/T…/` 中的 `T…` |
| `SLACK_TARGET_USER_IDS` | 你自己的 member ID，`U` 开头 | Slack 里点自己的头像 → **Profile** → **⋮** → **Copy member ID** |
| `SLACK_ALLOWED_CHANNEL_IDS` | `all`，或逗号分隔的频道 ID | 先填 `all` 跑通，再按需收窄 |
| `SLACK_ALLOWED_SENDER_IDS` | 先填你自己的 member ID | 不填时任何同事 @ 你都会触发 Agent；跑通后再放开 |
| `SLACK_REACTION_NAME` | `eyes` | 固定值，收到任务时加的表情 |
| `KV_REST_API_URL` | `UPSTASH_REDIS_REST_URL` 的值 | 本步第 2 项，必须是 `https://` 开头 |
| `KV_REST_API_TOKEN` | `UPSTASH_REDIS_REST_TOKEN` 的值 | 本步第 2 项 |
| `QSTASH_TOKEN` | 同名值 | 本步第 2 项 |
| `QSTASH_CURRENT_SIGNING_KEY` | 同名值 | 本步第 2 项 |
| `QSTASH_NEXT_SIGNING_KEY` | 同名值 | 本步第 2 项 |
| `MULTICA_API_BASE_URL` | Multica 服务地址，例如 `https://multica.example.com` | 不带 `/api` |
| `MULTICA_API_TOKEN` | Multica Personal Access Token | Multica 网页的个人设置 |
| `MULTICA_WORKSPACE_ID` | 工作区完整 ID | `multica workspace list` |
| `MULTICA_PROJECT_ID` | 接收 Slack 任务的项目 ID | `multica project list` |
| `MULTICA_ASSIGNEE_TYPE` | `agent` | 固定值 |
| `MULTICA_ASSIGNEE_ID` | 接单 Agent 的 ID | `multica agent list` |
| `RELAY_CONSUMER_URL` | `https://<Worker 地址>/api/queue/consume` | 见下一项 |

5. Worker 地址在 Worker 的 **Settings** → **Domains & Routes** 里，形如 `https://slack-multica-relay.<你的子域>.workers.dev`。
6. Secret 保存后立即生效。浏览器打开 `https://<Worker 地址>/api/health`，返回成功即入口可达。

QStash 必须能直接访问 Worker 地址，不要给它开 Cloudflare Access 或其他登录拦截。之后往 fork 推代码，Cloudflare 会自动重新部署，Secret 保持不变。

## 4. 开启事件订阅

1. App 设置页 → **Event Subscriptions**，打开 **Enable Events**。
2. **Request URL** 填 `https://<Worker 地址>/api/slack/events`，等它显示 **Verified**。
3. 在 **Subscribe to events on behalf of users** 里添加 `message.channels`、`message.groups`、`message.im` 和 `message.mpim`，点 **Save Changes**。

也可以在 **App Manifest** 的 `settings` 里加入同样的内容：

```json
"event_subscriptions": {
  "request_url": "https://<Worker 地址>/api/slack/events",
  "user_events": ["message.channels", "message.groups", "message.im", "message.mpim"]
}
```

这四个事件用的 scope 在第 2 步已经批过，不需要重新安装。订阅的是“代表用户”的事件，所以你所在的任何频道、群聊和私聊里有人 @ 你，Relay 都能收到，App 本身不用进频道。

## 5. 先验证入口

在任意一个你所在的会话里发一条 @ 你自己的消息（`SLACK_ALLOWED_SENDER_IDS` 放开后，再请同事 @ 你试一次）。几秒内这条消息上出现 👀，说明 Slack 事件、准入、QStash 和 Multica 写入都通了；Multica 项目里会多一个 Issue。

没有 👀 时，按顺序排查：

| 现象 | 先看哪里 |
| --- | --- |
| 第 4 步 Request URL 验证不过 | `/api/health` 能否打开；变量表里的 Secret 是否全部填好，`SLACK_SIGNING_SECRET` 是否填对 |
| 验证通过，但发消息没反应 | `SLACK_TEAM_ID`、`SLACK_TARGET_USER_IDS`、`SLACK_ALLOWED_CHANNEL_IDS`、`SLACK_ALLOWED_SENDER_IDS` 是否匹配 |
| Worker 的 **Observability** 日志里有 QStash 401 或发布失败 | `RELAY_CONSUMER_URL` 是否是 Worker 地址；五个 Upstash 变量是否都在 |
| 有 👀，Multica 里没有 Issue | `MULTICA_*` 变量，以及这个 PAT 能否访问该项目和 Agent |

## 6. 配置 Agent 回复

有了 Issue 以后，Agent 还需要能把答复发回 Slack。这一步在 Agent Runtime 所在的电脑上完成：

1. 把本仓库 clone 到这台电脑。
2. 在 Runtime 环境里配置 `SLACK_USER_TOKEN` 为第 2 步的 `xoxp-…`。Runtime 环境里同时存在 `SLACK_BOT_TOKEN` 时，Slack Skill 可能优先用 Bot 身份，所以只保留 user token。
3. 发布 `multica-skills/` 下的 `multica-final-reply` 和 `multica-slack-intent` 两个 Skill，并绑定到接单 Agent。
4. 按 [本地 reply adapter](CONFIGURATION.md#本地-reply-adapter) 和 [最终回复与私有风格配置](CONFIGURATION.md#最终回复与私有风格配置) 写好私有 JSON，再让 Runtime 环境的 `FINAL_REPLY_CONFIG` 指向这个文件。
5. 在 Agent Instructions 里写明：Slack 来的任务用 `multica-final-reply` 回复原线程。

Agent 要在回复里上传文件时，私有 JSON 还需要 `slackCliPath`，指向一个支持 `files_upload` 的 Slack Skill 脚本；只回复文字时可以后补。

再 @ 自己一次。Agent 在原线程回复、👀 被清掉，整条链路就通了。

## 之后

- 把 `SLACK_ALLOWED_CHANNEL_IDS` 从 `all` 收窄到需要的频道，或用 `SLACK_BLOCKED_CHANNEL_IDS` 排除不想接的频道。
- 把 `SLACK_ALLOWED_SENDER_IDS` 改成 `all` 或需要的同事 ID，让别人 @ 你也能触发。
- 用 Wrangler 命令行部署、本地调试，见 [配置说明](CONFIGURATION.md#cloudflare-workers)。
- 取消、Team 路由和定时任务见 [配置说明](CONFIGURATION.md)。Slack 原生的“思考中 / 停止”状态需要给 App 加 Bot 身份，见 [原生运行状态与停止](CONFIGURATION.md#原生运行状态与停止)。
