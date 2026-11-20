# Draftway 插件

插件为笔记增加命令和侧面板，入口在全局侧栏的“插件”和笔记右上角的拼图按钮中。

## 安装和使用

1. 打开“插件”，选择“安装本地插件”，选中含 `northstar-plugin.json` 的文件夹。
2. 查看插件申请的能力，点击“启用”。安装和更新后的插件默认停用。
3. 打开 Markdown 笔记，从拼图按钮运行命令或展开面板。

“试用示例：笔记工具”安装的是 [独立示例插件](../examples/plugins/note-tools/northstar-plugin.json)。它注册“整理多余空行”命令和“笔记大纲”面板；命令通过编辑器修改正文，修改可以撤销并随笔记自动保存。示例的围栏代码块内容保持原样。

当前插件在 Windows 版执行。浏览器预览支持插件管理，命令和面板入口显示运行条件。当前实现支持本地安装；Orca 和 Obsidian 的插件包需要按 Draftway API 适配。

停用会移除命令入口并结束正在显示的插件界面。卸载移除插件代码，保留插件自己的设置；笔记正文独立保存。插件包和设置保存在主数据库的独立元数据项中，随数据库备份恢复。

## 声明和入口

```json
{
  "manifestVersion": 1,
  "execution": "sandboxed-ui",
  "id": "local.my-tools",
  "name": "我的笔记工具",
  "version": "1.0.0",
  "capabilities": ["note.read", "note.edit"],
  "main": "main.js",
  "contributes": {
    "commands": [{"id": "example", "title": "运行示例"}],
    "panels": [{"id": "details", "title": "详情", "entry": "panel.html"}]
  }
}
```

`main.js` 是预先打包的普通 JavaScript，通过 `northstar.commands.register(id, run)` 注册声明中的命令。命令执行时创建运行界面，执行结束后销毁，不作为后台进程常驻。面板入口为 HTML，可通过相对路径引用插件中的普通 JS 和 CSS；也可直接内嵌。资源路径使用 `/`，禁止绝对路径和 `..`。当前最多 12 个插件，每个包最多 32 个文本文件、800 KB，每个插件最多 32 个命令和 8 个面板。

## 宿主 API 1.0

`window.northstar` 在插件代码执行前提供，声明类型见 [northstar.d.ts](../examples/plugins/note-tools/northstar.d.ts)。

| API | 需要的能力 | 行为 |
| --- | --- | --- |
| `note.read()` | `note.read` | 读取此编辑器绑定的笔记、选区和正文修订号 |
| `note.edit({from,to,text,revision})` | `note.edit` | 修订匹配时替换指定正文范围，进入编辑器撤销历史 |
| `note.select({from,to})` | `note.read` | 定位正文选区 |
| `storage.get(key)` / `storage.set(key,value)` | `storage.own` | 读写此插件的 JSON 数据，合计上限 64 KB |
| `on('note.changed',listener)` | 无，事件不含正文 | 监听正文变化；读取内容仍需 `note.read` |

插件通过专属 MessagePort 调用上述 API。正文范围越界、修订冲突、只读笔记和未声明能力均拒绝操作。插件仅获得绑定笔记的上下文，不接受另一个笔记的 ID。命令有启动和执行超时，请求限流为每秒 60 次。

Windows 插件界面复用现有隔离 HTML 协议：opaque iframe、`sandbox="allow-scripts"`、禁止网络和宿主命令访问的 CSP。插件使用宿主 API，不取得文件路径、进程接口或 Agent 凭据。

设计参考 Orca 的 [Manifest、贡献点和隔离界面 API](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md)。Draftway 本阶段实现笔记命令和面板；主题、自定义文件编辑器、远程插件目录和独立进程插件尚未实现。
