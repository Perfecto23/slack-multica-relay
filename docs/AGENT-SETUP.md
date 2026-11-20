# Agent 搭建指南

本文写给替用户搭建 Relay 的 Agent。你负责把用户从零带到“同事在 Slack 里 @ 他，他的 Multica Agent 在原线程回复”。先完整读 [SETUP.md](SETUP.md)：点击路径、变量表和排障表以它为准。本文规定分工、交接和验收；文中的命令行检查是你在网页操作之外的补充验收手段。流程图在 [setup-flow.html](setup-flow.html)，用浏览器打开本地文件即可，适合在第 0 步之后给用户看全貌。

**完成标准**：用户之外的一位同事在私聊里 @ 用户，这条消息出现 👀，Multica 项目里出现对应 Issue，用户的 Agent 在原线程回复，👀 随后被清掉。六步各有验收，上一步验收通过再做下一步。

## 第 0 步：盘点这台电脑

先查清楚你手里有什么，再决定怎么带用户走。逐项实际调用或运行一次，以结果为准：

| 能力 | 怎么查 | 用来做什么 |
| --- | --- | --- |
| 浏览器自动化 | 你的工具列表里有没有浏览器工具（内置浏览器、Chrome 扩展、Playwright MCP、ego-browser 等），能否打开 `https://api.slack.com/apps` 并读到页面 | 替用户操作 Slack、Cloudflare、Upstash、GitHub 网页 |
| Computer use | 能否截屏并点击桌面应用 | 没有浏览器工具时的替代 |
| 用户已登录的会话 | 打开上面的页面，看到的是 **Your Apps** 还是登录页 | 决定登录是否要交给用户 |
| `git`、`gh` | `git --version`、`gh auth status` | 用 `gh repo fork Perfecto23/slack-multica-relay` fork；没有时在 GitHub 网页上点 **Fork** |
| Multica CLI | `multica --version`、`multica workspace list`、`multica runtime list` | 取 ID、发布 Skill、第 6 步配置 Runtime |
| `curl`、Python 3 | `curl --version`、`python3 --version` | 健康检查；第 6 步的 reply adapter |

盘点完，用两三句话告诉用户结果和接下来的模式：

- **代操作模式**：有可用的浏览器或 computer use。你在网页上操作，用户只在交接点出手。
- **向导模式**：两样都没有。用户自己点，你每次讲一步，用户做完回报，你再验收。

两种模式的步骤、交接点和验收完全相同，区别只在网页上那一下由谁点。

## 物料清单

开始前列给用户看，让他知道要准备什么。

| 物料 | 秘密 | 谁拿 | 去向 |
| --- | --- | --- | --- |
| Slack 工作区成员账号、GitHub、Cloudflare、Upstash 账号 | — | 用户注册或登录 | — |
| 用户的 Slack member ID（`U…`）、工作区 ID（`T…`） | 否 | 你读 | Worker Secret |
| Signing Secret | 是 | 用户复制 | Worker Secret |
| User OAuth Token（`xoxp-…`） | 是 | 用户复制 | Worker Secret ×2，Runtime 环境 |
| Upstash Redis REST URL / token，QStash token 和两把 signing key | 是 | 用户复制 | Worker Secret |
| Multica PAT | 是 | 用户在 Multica 网页的个人设置里创建并复制 | Worker Secret |
| Multica 服务地址 | 否 | 你用 `multica config show \| grep -i url` 读，或问用户 Multica 网页的域名；去掉末尾的 `/api` | Worker Secret |
| Multica workspace / project / agent ID | 否 | 你用 `multica workspace list`、`multica project list`、`multica agent list` 查 | Worker Secret |
| Worker 地址 | 否 | 部署后你在 Worker 的 **Settings → Domains & Routes** 读 | Slack Request URL、`RELAY_CONSUMER_URL` |

## 秘密值怎么走

秘密值只经用户的手，从源页面直接进入目标输入框。你处理的始终是变量名和“已设置 / 未设置”这类结果：

- **填 Secret**：你在 Cloudflare **Variables and Secrets** 里点 **Add**，填好变量名、类型选 **Secret**，把光标停在值输入框，请用户粘贴并点 **Save**。非秘密项（ID、地址、`all`、`eyes`）由你直接填完保存。
- **看含秘密的页面**：Slack 的 **OAuth & Permissions**、**Basic Information**，Upstash 的数据库详情页，都会显示秘密值。在这些页面只用查找元素的方式确认目标标签或 **Copy** 按钮存在，不截全页、不读整页文本。
- **核对**：填完后读 Secrets 列表的变量名，与 SETUP.md 第 3 步的变量表逐个比对。Runtime 环境用 `[ -n "$SLACK_USER_TOKEN" ] && echo set` 这样只输出是否设置的命令检查。

## 交接点

遇到下面这些情况，停下来交给用户，说清楚他要做什么、做完回报什么：

- **登录、注册、两步验证、验证码、接受条款**：账号是用户的，由用户完成。
- **授权第三方应用**：Cloudflare 连接 GitHub、用 GitHub 登录 Upstash 时出现的授权页，由用户点同意。
- **Slack 安装审批**：用户点 **Request to Install** 后，需要工作区管理员批准，可能要等几小时。等待期间按下面第 3 步的说明继续部署。
- **粘贴秘密值**：按上一节的方式交给用户。
- **花钱或超出免费额度的选择、任何删除**：由用户决定。

## 怎么和用户讲步骤

每条消息只讲一步，按这个顺序写：

1. 这一步做什么，为什么要做，一句话。
2. 去哪里点：完整的点击路径，按钮名照网页原文写，例如 **OAuth & Permissions** → **Request to Install**。
3. 做完回报什么：只要非秘密的结果，例如“页面显示 Verified”、Worker 地址、一张不含秘密的截图。
4. 做对了会看到什么。

用户回报后，你先验收，再讲下一步。用户卡住时，请他截图，对照 SETUP.md 的排障表判断，每次只给一个改法，并说明改完怎么验证。

## 六步：分工与验收

| 步骤 | 你做 | 用户做 | 验收 |
| --- | --- | --- | --- |
| 1. 创建 Slack App | 打开 **Create New App → From a manifest**，粘贴 [slack-app-manifest.json](slack-app-manifest.json)，名字按用户的意思改；已有 App 时改 **App Manifest** 里的 scope | 登录 Slack | **OAuth & Permissions** 列出的 User scope 与 manifest 逐项一致 |
| 2. 安装 App | 打开 **OAuth & Permissions**，告诉用户点哪个按钮 | 点 **Install to Workspace** 或 **Request to Install**；审批通过后完成安装 | 页面上能找到 **User OAuth Token** 标签和它的 **Copy** 按钮 |
| 3. 部署 Worker | fork 仓库；在 Cloudflare 导入 fork 并部署一次；读 Worker 地址；填非秘密项，包括 `RELAY_CONSUMER_URL` = `https://<Worker 地址>/api/queue/consume` | 注册 Cloudflare 和 Upstash；授权 GitHub；粘贴秘密值 | Secret 名字与变量表一致；`curl -s -o /dev/null -w '%{http_code}' https://<Worker 地址>/api/health` 输出 `200` |
| 4. 开启事件订阅 | 填 Request URL，添加四个 user events，保存 | — | 页面显示 **Verified**，保存成功 |
| 5. 验证入口 | 请用户 @ 自己发一条消息；用 `multica issue list --project <项目 ID> --limit 5` 查新 Issue | 发消息，回报是否出现 👀 | 用户确认出现 👀；列表里有这条消息对应的新 Issue |
| 6. 配置回复 | 在 Runtime 电脑上 clone 仓库，发布并绑定 `multica-final-reply`、`multica-slack-intent`，按 [配置说明](CONFIGURATION.md#本地-reply-adapter) 写私有 JSON（只含 ID、路径和显示名） | 把 `xoxp-` token 写进 Runtime 环境的 `SLACK_USER_TOKEN`；确认 Agent Instructions | `SLACK_USER_TOKEN` 显示已设置、`SLACK_BOT_TOKEN` 显示未设置；用户再 @ 一次，回报原线程里的回复截图，👀 已清掉 |

**第 2、3、4 步的先后**：等审批期间，第 3 步做到 `/api/health` 输出 `200` 为止，两个 `xoxp-` Secret 先空着。审批通过、完成安装后，用户补上这两个 Secret，再做第 4 步。Relay 校验 Request URL 时会加载全部必填变量，缺任何一个都验证不过。

第 5 步通过后，把 `SLACK_ALLOWED_SENDER_IDS` 放开到 `all` 或用户指定的同事，请一位同事 @ 用户，按完成标准做最后一次验收：用户回报线程截图，你在 `multica issue list` 里确认对应 Issue 已完成。

## 收尾

验收通过后，给用户一段简短总结：

- Worker 地址；
- 当前的频道和发送者范围；
- 哪些 Secret 存在 Cloudflare，哪个 token 存在 Runtime 环境；
- 以后改 scope 要重新安装，可能还要再审批一次。
