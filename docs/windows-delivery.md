# Windows 工作区预览交付

运行 `artifacts/native-preview/northstar.exe`；安装包为 `artifacts/Northstar-Workspace-Preview-Setup.exe`。预览的应用标识是 `com.northstar.workbench.preview`，与已安装原版的数据目录分开。安装包仅在本机生成，没有上传为 GitHub Release，也没有合并主分支。

## 核心组件

| 组件 | 已实现 |
| --- | --- |
| 工作区 | 常驻侧栏、直接切换、自增工作区、独立布局、布局模板和网页声明导入 |
| 地图与事件 | 直接加节点、语义类型、正文、进度、步骤、材料、来源会话与更新记录 |
| 分屏页签 | 地图、会话、浏览器、文件审查、材料、报告和原有业务组件；拖放、分隔条与键盘调整 |
| Agent | Codex app-server、Claude stream-json、Pi RPC；真实流式记录、恢复、停止和交互请求 |
| 工作区工具 | MCP 读取、进展、内容更新、产物保留；操作去重与并发编辑保护 |
| 材料与审查 | 授权目录及默认工作目录读取、Obsidian 定位接口、文件夹引用、真实 Git 差异 |
| 后台 | 会话与本机检视状态、持久通知、结果定位、断线保留及历史基线 |
| 原有业务 | 目标、项目、任务、记录、笔记、习惯、健康、日历、画板、附件与归档 |
| 数据 | SQLite 快照、会话日志、完整备份、旧版兼容、跨目录恢复、回滚与中断恢复保护 |

新配置从一个空白中心开始。已有地图和原型数据保留，原版业务入口继续使用原业务记录。浏览器里的 Agent 是明确标注的模拟；真实执行在 Windows 版中使用本机执行器。

## 快捷键

| 操作 | 按键 |
| --- | --- |
| 切换工作区 | Alt + 1…9 |
| 最近页签 | Ctrl + Tab / Ctrl + Shift + Tab |
| 相邻页签 | Ctrl + Shift + [ / ] |
| 浏览器新页签 / 关闭当前页签 | Ctrl + T / Ctrl + W |
| 网页地址 | Ctrl + L |
| 地址与原生网页间切换焦点 | F6 |
| 地图搜索 | Ctrl + K |

网页聚焦时由宿主转发工作区快捷键；普通网页缩放、查找和编辑按键交给浏览器处理。关闭页签保留会话，停止生成需要单独操作。

## 验证与边界

具体阶段提交和检查结果见 [组件交付记录](component-delivery.md)。已完成真实 Codex/Pi 运行、MCP 地图调用、跨目录会话恢复、本机检视 GET、原生浏览器、业务桥接和桌面自动重开的运行检查。界面操作验证覆盖直接建节点、进入会话、保留结果定位、分屏、比例调整与草稿恢复。

Claude 适配已实现，本机实际生成受现有订阅状态限制。Windows GUI 工具的窗口激活与捕获失败，原生物理按键、鼠标拖放、Obsidian 唤起及系统通知横幅没有完成目视验收；原生 API 检查不能替代这些验收。

材料与 MCP 工作区工具按宿主目录范围校验；执行器的其他工具权限沿用其各自配置。完全退出会停止北极星拥有的执行器；独立检视服务继续由原服务管理。网页登录态、外部项目文件和执行器认证的恢复范围见 [备份说明](backup-recovery.md)。

## 复现检查

```powershell
npm test
npm run build
npm run test:native-browser
npm run test:native-business
npm run test:native-recovery
npm run test:agent-live -- pi passthrough
npm run test:agent-backup
npm run desktop:next:release
```

真实 Agent 检查使用本机已配置账号，会产生真实调用；这些检查不属于默认单元测试。构建产物、运行数据和私有配置不提交到 Git。
