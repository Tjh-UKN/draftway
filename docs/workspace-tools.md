# AI 工作区工具

Windows 宿主为新建及恢复的 Codex、Claude Code、Pi 会话提供标准 MCP stdio 工作区工具。工具连接只加入该次执行器启动参数，不修改用户的全局 Agent 配置。Pi 版本带 MCP 注册接口时使用原接口；本机 Pi 0.84 使用其自定义工具接口桥接同一组 MCP 调用。

| 工具 | 行为 |
| --- | --- |
| `northstar_workspace_read` | 当前工作区与节点摘要，包含任务能力标记 |
| `northstar_node_read` | 指定节点的完整内容、材料引用和子节点摘要 |
| `northstar_material_read` | 读取已关联且位于授权目录的文本材料 |
| `northstar_progress` | 追加带来源会话、执行标识的进展 |
| `northstar_update_node` | 按读取时的旧正文校验更新，冲突时保存建议 |
| `northstar_keep_artifact` | 明确保留产物为指定节点的子节点 |

节点必须属于调用会话的工作区。执行结束或停止后工具调用失效。材料目录和关联仍由用户管理；工具不能新增任意文件读取权限。执行器要求的授权通过会话内请求处理，不默认批准未知工具或系统权限。

变更先写入 SQLite 操作日志，保存唯一变更标识、来源和序号。重复相同标识不会重复追加；同标识改用另一份内容会报错。前台定期同步日志，保存旧界面快照时也会补入尚未合并的操作。正文有同时编辑时保留用户内容，将 AI 的正文放进更新记录；事件进度和完成验收不随工具成功而改变。

普通回复没有地图副作用。产物工具是明确的保留动作，创建会话也不生成节点。地图回写不移动当前页签、不抢占正在使用的工作区。

节点统一编辑内容；现有 MCP 的 `title`、`body` 和 `expectedBody` 字段继续兼容。子任务使用真实节点关系，发送节点上下文时同时带上直属子节点和任务进度，不再维护独立行动步骤列表。历史引用读取继续兼容，迁移后的材料优先按统一材料标识查找。

已验证 Codex 与 Pi 真实调用：读取工作区、带来源追加进展、创建产物节点、保持原任务进度。另有跨工作区拒绝、停止后拒绝、去重、并发保存和正文冲突的单元检查。Claude 连接参数已接入，实际生成仍受本机现有订阅状态限制。

接口依据：[MCP stdio 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Claude MCP](https://code.claude.com/docs/en/mcp)、[Pi 扩展](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)。
