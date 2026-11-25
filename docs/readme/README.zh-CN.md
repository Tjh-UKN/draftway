<h1 align="center">
  <img src="../../src-tauri/icons/128x128.png" alt="" width="44" height="44" valign="middle"> Draftway
</h1>

<p align="center">
  <strong>把项目地图、笔记和 AI 会话放在同一个本地工作台。</strong><br>
  从地图节点发起会话，在分屏里继续工作，把有用的结果留回项目。
</p>

<p align="center">
  <a href="#快速开始"><strong>快速开始</strong></a> ·
  <a href="#windows-桌面版">Windows</a> ·
  <a href="../../README.md">English</a> ·
  <a href="https://github.com/Tjh-UKN/draftway#start-of-content">★ 点星</a>
</p>

<p align="center">
  <a href="workbench.webp"><img src="workbench.webp" width="1120" alt="Draftway 左侧是工作区分组，中间是山海背景下的 Atlas 项目地图，右侧是关联节点的 Codex 会话"></a>
  <br><sub>浏览器预览实拍，项目与会话为演示数据。</sub>
</p>

## 你可以用它做什么

<table>
  <tr>
    <td width="43%" valign="middle">
      <h3>给工作区分组，在地图上拆项目</h3>
      <p>在侧栏拖动工作区完成归组和排序，用地图节点组织想法、任务和文档。每张地图各自记住网格、星空或山海背景。</p>
      <a href="../mindmap-editing.md">地图操作</a> · <a href="../materials.md">关联材料</a>
    </td>
    <td width="57%">
      <a href="project-map.webp"><img src="project-map.webp" alt="星空背景下的 Atlas 项目地图及其计划和发布分支"></a>
    </td>
  </tr>
  <tr>
    <td width="43%" valign="middle">
      <h3>让会话跟着项目走</h3>
      <p>在 Windows 版中，从节点启动 Codex、Claude Code 或 Pi。分屏并排查看地图与会话，在会话里跟进执行活动，也能从工作区的会话记录中重新打开已关闭的页签。</p>
      <a href="../windows-delivery.md">Windows 功能</a>
    </td>
    <td width="57%">
      <a href="agent-session.webp"><img src="agent-session.webp" alt="关联 QA 节点的 Codex 模拟会话，检查清单可以保留到地图"></a>
    </td>
  </tr>
  <tr>
    <td width="43%" valign="middle">
      <h3>把做完的东西留下来</h3>
      <p>在节点的「素材区」查看关联会话中可用的文件和链接，将有用的条目加入「产出区」。在成果卡片上点「保留到地图」会生成产物节点。有正文的产物和文档节点、工作区随记会进入个人知识库。</p>
      <a href="../personal-knowledge.md">个人知识库</a>
    </td>
    <td width="57%">
      <a href="knowledge-library.webp"><img src="knowledge-library.webp" alt="个人知识库按来源工作区展示文档和已留存的发布检查清单"></a>
    </td>
  </tr>
</table>

## 快速开始

安装 Git 和 Node.js 20 或更高版本，克隆项目后启动预览。

```powershell
git clone https://github.com/Tjh-UKN/draftway.git
cd draftway
npm ci
npm run dev
```

打开[本地浏览器预览](http://127.0.0.1:1420/next.html)。浏览器预览使用独立存储和模拟 Agent。

1. 点侧栏搜索旁的 **+**，选择 **新建工作区** 或 **新建分组**。拖动工作区即可归组。
2. 把鼠标移到地图节点上，点 **+** 添加子节点。在地图工具栏点 **背景** 可选 **网格**、**星空** 或 **山海**。
3. 点节点上的 **查看节点详情**，选择 **新建会话**，把会话关联到这个节点。

### Windows 桌面版

安装 Rust MSVC 工具链、Visual Studio 的 **使用 C++ 的桌面开发** 工作负载和 WebView2 后，在同一目录构建并启动。

```powershell
npm run desktop:next:build
.\src-tauri\target\debug\northstar.exe
```

Draftway 使用本机已配置的 Agent 和登录凭据。运行 `npm run desktop:next:release` 可生成 Windows 安装包。[Windows 交付与验证](../windows-delivery.md)

## 本地数据

桌面版将工作区状态与会话历史保存在本机 SQLite，支持在设置中导出与恢复完整备份。Agent 请求使用本机执行器已配置的服务和凭据。[备份与恢复](../backup-recovery.md)

## 更多

- [Agent 工作区工具（MCP）](../workspace-tools.md) · [插件](../plugins.md) · [经典工作台使用手册](../classic-workbench.md)
- [反馈问题或提功能建议](https://github.com/Tjh-UKN/draftway/issues)
