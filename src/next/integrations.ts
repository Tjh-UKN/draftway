export interface IntegrationDefinition {
  id: string;
  name: string;
  description: string;
  capabilities: readonly ('surface' | 'session' | 'run')[];
  available: boolean;
}

// The shell consumes capabilities; provider-specific process/HTTP code belongs in adapters.
export const integrations: readonly IntegrationDefinition[] = [
  {id: 'graph', name: '思维导图', description: '语义、分析与任务，围绕一个方向展开', capabilities: ['surface'], available: true},
  {id: 'tasks', name: '任务', description: '查看图谱中的任务与进度', capabilities: ['surface'], available: true},
  {id: 'note', name: '笔记', description: '每个笔记视图独立保存内容', capabilities: ['surface'], available: true},
  {id: 'web', name: '网页工具', description: '保存网页入口，在独立页面操作原工具', capabilities: ['surface'], available: true},
  {id: 'demo-agent', name: '模拟 Agent', description: '仅验证会话、执行状态和通知流程', capabilities: ['session', 'run'], available: true},
  {id: 'codex', name: 'Codex', description: '本机 app-server，会话记录与执行分别保存', capabilities: ['session', 'run'], available: true},
  {id: 'claude', name: 'Claude Code', description: '本机或 WSL，流式会话与权限请求', capabilities: ['session', 'run'], available: true},
  {id: 'pi', name: 'Pi', description: '本机或 WSL，RPC 会话与扩展交互', capabilities: ['session', 'run'], available: true},
];
export const agentNames = {codex: 'Codex', claude: 'Claude Code', pi: 'Pi'};

export const integrationById = (id: string) => integrations.find(item => item.id === id);
