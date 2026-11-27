# 协作室（switchboard room）

协作室连接局域网内的 [switchboard room](https://pypi.org/project/switchboard-room/) 服务。多台机器上的 Claude Code 会话通过它互发消息、提问和回答；Draftway 以 `draftway@<本机名称>` 的身份加入，查看各会话状态并发送消息。默认不连接，未配置时不产生任何网络请求。

## 连接

1. 有人在局域网内运行 `room serve`，并提供服务地址和令牌。
2. 在工作区标题栏点击“协作室”，填写服务地址（如 `http://192.168.1.20:8766`）、令牌和本机名称，点击“连接”。
3. 本机已用 `room join` 加入时，可直接点击“使用本机 room 配置”，读取 `~/.config/switchboard/room.json`。

连接信息保存在数据目录的 `room-connection.json`，不写入数据库，备份和导出不包含令牌。点击“断开”删除该文件。

## 使用

| 区域 | 行为 |
| --- | --- |
| 会话 | 按主机列出协作室中的会话：名称、仓库、状态说明、待命（运行 `room listen`）和未读数。点击会话即设为收件人 |
| 消息 | 最近的消息。发给 Draftway 的消息和对 Draftway 提问的回复加框显示；点击回复按钮按 `room send --re` 方式回复 |
| 发送 | 收件人可写 `name@host`、`repo:仓库`、`link:主题`。勾选“提问”后，对方会在本轮内回答 |

Draftway 在每台机器上使用固定身份，`room who` 中显示为 `draftway@<本机名称>`。窗口打开时每 5 秒刷新，并把发给 Draftway 的消息标为已读；关闭窗口时登记离开，之后不再访问协作室。

## Draftway 启动的 Claude Code 会话

本机安装了 room 钩子（`room join` 或 `room install-hooks`）时，Draftway 新建的 Claude Code 会话会由钩子自动加入协作室，消息在会话的下一轮进入上下文。这类会话由钩子登记，没有名称；协作室窗口在本机以 Draftway 会话标题显示它们，并提供“打开会话”，不改动钩子登记的信息。每个会话退出后仍在 `room who` 中列出 24 小时，退出后收到的提问会保持未读。Codex 和 Pi 会话不在协作室中。

## 信任

同一协作室的成员共用一个令牌，消息会作为上下文进入对方会话。只连接你信任的协作室。服务使用明文 HTTP，请仅在可信网络中使用；跨网络协作可使用 Tailscale 等私有网络。
