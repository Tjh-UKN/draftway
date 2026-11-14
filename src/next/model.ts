import {validMaterial, type NodeMaterial} from './material-target';
export type NodeKind = 'root' | 'idea' | 'analysis' | 'event' | 'document' | 'code' | 'artifact';
export interface NodeUpdate {id: string; text: string; at: number; sessionId?: string}
export type ViewKind = 'map' | 'events' | 'notes' | 'web';
export interface Step {id: string; title: string; done: boolean}
export interface MindNode {
  id: string; parentId: string | null; side: -1 | 1; kind: NodeKind;
  title: string; body: string; progress: number; due: string; steps: Step[];
  completed?: boolean; reference?: string; materials?: NodeMaterial[]; updates?: NodeUpdate[]; sourceArtifactId?: string;
}
export interface Space {
  id: string; name: string; intent: string; symbol: 'star' | 'code' | 'book';
  components: ViewKind[]; nodes: MindNode[]; notes: string; website: string;
}
export interface DesignState {version: 2; activeId: string; spaces: Space[]}
export interface PlacedNode {node: MindNode; x: number; y: number; width: number; height: number}
export const storageKey = 'northstar-design-v2';
export const viewNames: Record<ViewKind, string> = {map: '思维', events: '事件', notes: '随记', web: '网页'};
export const viewDescriptions: Record<ViewKind, string> = {map: '让想法围绕一个中心生长', events: '从节点延伸，持续推进每一件事', notes: '留下还没有成形的灵感', web: '接入你已经在使用的工具'};
const node = (id: string, parentId: string | null, title: string, side: -1 | 1 = 1, kind: NodeKind = 'idea', progress = 0, body = ''): MindNode => ({id, parentId, title, side, kind, progress, body, due: '', steps: []});

export function seedState(): DesignState {
  const design: Space = {
    id: 'design', name: '产品设计', intent: '让想法与行动，在同一个空间生长。', symbol: 'star', components: ['map', 'events', 'notes'], website: '',
    notes: '好的工具，应该让事情变简单。\n\n先有一个清晰的方向，再让想法自然生长。只有需要时，才展开下一层。',
    nodes: [
      node('northstar', null, '新的北极星', 1, 'root', 0, '一个方向，两种生长。想清楚，然后做出来。'),
      node('think', 'northstar', '想清楚', -1, 'idea', 0, '从想法出发，保留思考的自由。'),
      node('simplicity', 'think', '一个中心，逐层展开', -1, 'idea', 0, '首屏只保留一个中心。复杂度随人的意图出现，而不是一开始堆在眼前。'),
      node('composition', 'think', '工具围绕事情组织', -1, 'idea', 0, '工作区属于业务；组件属于工作区。不同的事情，有不同的工具组合。'),
      node('act', 'northstar', '做出来', 1, 'idea', 0, '每个值得付诸行动的想法，都可以成为一件有进展的事。'),
      {...node('link', 'act', '连接想法与事件', 1, 'event', 75, '点击思维节点就能编辑事件。思维图和事件列表使用同一条记录，进度随时同步。'), steps: [{id: 's1', title: '建立节点与事件的关联', done: true}, {id: 's2', title: '在节点中编辑事件', done: true}, {id: 's3', title: '让进度回到思维图', done: true}, {id: 's4', title: '完成一次完整体验', done: false}]},
      node('spaces', 'act', '工作区自由组合', 1, 'event', 40, '切换业务的同时，切换思维、事件、随记和网页入口。每个工作区都可以调整组件和顺序。'),
      node('experience', 'act', '打磨界面与动效', 1, 'event', 20, '留白、层级与节奏。让注意力始终停留在正在做的那件事。'),
    ],
  };
  const review: Space = {id: 'review', name: '研发检视', intent: '让每一次检视，都有清晰的去向。', symbol: 'code', components: ['web', 'events', 'map'], website: 'http://127.0.0.1:8765/', notes: '', nodes: [node('review-root', null, 'PR 检视', 1, 'root'), node('review-idea', 'review-root', '把注意力留给关键变化', -1), node('review-event', 'review-root', '整理本轮检视结论', 1, 'event', 30, '这是设计示例事件。真实的 PR 与检视报告仍由原看板管理。')]};
  const learn: Space = {id: 'learn', name: '学习与认知', intent: '把知道的，慢慢变成自己的。', symbol: 'book', components: ['map', 'notes', 'events'], website: '', notes: '今天，有什么改变了我的理解？\n\n', nodes: [node('learn-root', null, '理解与内化', 1, 'root'), node('learn-read', 'learn-root', '输入', -1), node('learn-note', 'learn-read', '用自己的话重新表达', -1), node('learn-action', 'learn-root', '输出', 1), node('learn-event', 'learn-action', '写下一个新的认识', 1, 'event', 0)]};
  return {version: 2, activeId: design.id, spaces: [design, review, learn]};
}

export function nodeProgress(nodes: MindNode[], id: string): number {
  const current = nodes.find(n => n.id === id);
  if (!current) return 0;
  if (current.kind === 'event') return current.progress;
  const events = descendants(nodes, id).filter(n => n.kind === 'event');
  return events.length ? Math.round(events.reduce((sum, n) => sum + n.progress, 0) / events.length) : 0;
}

export function descendants(nodes: MindNode[], id: string): MindNode[] {
  const ids = new Set([id]);
  const result: MindNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    let added = false;
    for (const n of nodes) if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) {ids.add(n.id); result.push(n); added = true;}
    if (!added) break;
  }
  return result;
}

export function placeNodes(nodes: MindNode[], collapsed: string[] = [], focusId?: string | null): PlacedNode[] {
  const root = nodes.find(n => n.id === focusId) || nodes.find(n => !n.parentId);
  if (!root) return [];
  const children = (id: string) => collapsed.includes(id) ? [] : nodes.filter(n => n.parentId === id);
  const height = (id: string): number => Math.max(108, children(id).reduce((sum, n) => sum + height(n.id), 0));
  const placed: PlacedNode[] = [{node: root, x: 0, y: 0, width: 196, height: 120}];
  function branch(current: MindNode, depth: number, y: number, side: -1 | 1) {
    placed.push({node: current, x: side * (depth === 1 ? 278 : 554 + (depth - 2) * 276), y, width: current.kind === 'event' ? 226 : 208, height: current.kind === 'event' ? 86 : 68});
    const items = children(current.id);
    let top = y - items.reduce((sum, n) => sum + height(n.id), 0) / 2;
    for (const item of items) {const h = height(item.id); branch(item, depth + 1, top + h / 2, side); top += h;}
  }
  for (const side of [-1, 1] as const) {
    const items = children(root.id).filter(n => (focusId ? root.side : n.side) === side);
    let top = -items.reduce((sum, n) => sum + height(n.id), 0) / 2;
    for (const item of items) {const h = height(item.id); branch(item, 1, top + h / 2, side); top += h;}
  }
  return placed;
}

export function newSpace(name: string, preset: 'blank' | 'project' | 'web'): Space {
  const id = crypto.randomUUID();
  const root = node(crypto.randomUUID(), null, name, 1, 'root');
  return {id, name, symbol: preset === 'web' ? 'code' : 'star', intent: '从一个想法开始。', components: preset === 'web' ? ['web', 'events'] : ['map', 'events', 'notes'], website: '', notes: '', nodes: preset === 'project' ? [root, node(crypto.randomUUID(), root.id, '想清楚', -1), node(crypto.randomUUID(), root.id, '做出来', 1)] : [root]};
}

export function parseState(value: unknown): DesignState {
  const result = value as DesignState;
  if (result?.version !== 2 || !Array.isArray(result.spaces) || !result.spaces.length || result.spaces.length > 20 || !result.spaces.some(s => s.id === result.activeId)) throw new Error('无法读取这份工作区数据。');
  const ids = new Set<string>();
  for (const space of result.spaces) {
    if (typeof space.id !== 'string' || ids.has(space.id) || typeof space.name !== 'string' || !space.name.trim() || space.name.length > 40 || !['star', 'code', 'book'].includes(space.symbol) || typeof space.intent !== 'string' || typeof space.notes !== 'string' || typeof space.website !== 'string' || !Array.isArray(space.components) || !space.components.length || new Set(space.components).size !== space.components.length || space.components.some(c => !Object.keys(viewNames).includes(c)) || !Array.isArray(space.nodes) || !space.nodes.length || space.nodes.length > 250) throw new Error('工作区配置不完整。');
    ids.add(space.id);
    if (space.nodes.filter(n => n.parentId === null && n.kind === 'root').length !== 1) throw new Error('每个工作区需要一个中心。');
    const nodeIds = new Set(space.nodes.map(n => n.id));
    if (nodeIds.size !== space.nodes.length) throw new Error('节点重复。');
    for (const n of space.nodes) {
      if (typeof n.id !== 'string' || typeof n.title !== 'string' || !n.title.trim() || n.title.length > 120 || !['root', 'idea', 'analysis', 'event', 'document', 'code', 'artifact'].includes(n.kind) || ![-1, 1].includes(n.side) || typeof n.body !== 'string' || typeof n.due !== 'string' || !Number.isFinite(n.progress) || n.progress < 0 || n.progress > 100 || !Array.isArray(n.steps) || n.steps.length > 100 || n.steps.some(s => typeof s.id !== 'string' || typeof s.title !== 'string' || typeof s.done !== 'boolean') || (n.kind === 'root') !== (n.parentId === null) || (n.completed !== undefined && typeof n.completed !== 'boolean') || (n.reference !== undefined && typeof n.reference !== 'string') || (n.sourceArtifactId !== undefined && typeof n.sourceArtifactId !== 'string') || (n.updates !== undefined && (!Array.isArray(n.updates) || n.updates.some(u => !u || typeof u.id !== 'string' || typeof u.text !== 'string' || !Number.isFinite(u.at) || (u.sessionId !== undefined && typeof u.sessionId !== 'string'))))) throw new Error('节点内容不完整。');
      if (n.materials !== undefined && (!Array.isArray(n.materials) || n.materials.length > 100 || !n.materials.every(validMaterial) || new Set(n.materials.map(m => m.id)).size !== n.materials.length)) throw new Error('关联材料格式无效。');
      let parent = n.parentId;
      const visited = new Set([n.id]);
      while (parent) {if (visited.has(parent) || !nodeIds.has(parent)) throw new Error('节点关系无效。'); visited.add(parent); parent = space.nodes.find(item => item.id === parent)!.parentId;}
    }
  }
  return result;
}

export function safeWebUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || value.length > 2048) throw new Error('请填写完整的 HTTP 或 HTTPS 网页地址。');
  return parsed.href;
}
