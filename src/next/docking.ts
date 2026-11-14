export interface ReviewFile {name: string; text: string}
export type DockTab =
  | {id: string; kind: 'map'; title: string}
  | {id: string; kind: 'session'; title: string; sessionId: string}
  | {id: string; kind: 'browser'; title: string; url: string}
  | {id: string; kind: 'report'; title: string; url: string; file: string}
  | {id: string; kind: 'material'; title: string; nodeId: string; materialId: string}
  | {id: string; kind: 'review'; title: string; files: ReviewFile[]};
export interface TabGroup {kind: 'group'; id: string; tabs: string[]; activeId: string}
export interface Split {kind: 'split'; id: string; axis: 'row' | 'column'; ratio: number; children: [DockNode, DockNode]}
export type DockNode = TabGroup | Split;
export interface DockState {root: DockNode; tabs: DockTab[]; activeGroupId: string; recent: string[]}
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export const groups = (node: DockNode): TabGroup[] => node.kind === 'group' ? [node] : node.children.flatMap(groups);
export const focusedGroup = (dock: DockState) => groups(dock.root).find(g => g.id === dock.activeGroupId)!;
const touch = (recent: string[], id: string) => [...recent.filter(value => value !== id), id];
function mapTree(node: DockNode, id: string, update: (node: DockNode) => DockNode): DockNode {
  return node.id === id ? update(node) : node.kind === 'group' ? node : {...node, children: node.children.map(child => mapTree(child, id, update)) as [DockNode, DockNode]};
}
function prune(node: DockNode, emptyId: string): DockNode | null {
  if (node.kind === 'group') return node.tabs.length || node.id !== emptyId ? node : null;
  const [a, b] = node.children.map(child => prune(child, emptyId));
  return a && b ? {...node, children: [a, b]} : a || b;
}
export function initialDock(ids: string[] = [], activeId = 'workspace', recent = ['workspace']): DockState {
  return {root: {kind: 'group', id: 'main', tabs: ['workspace', ...ids], activeId}, activeGroupId: 'main', recent,
    tabs: [{id: 'workspace', kind: 'map', title: '工作区'}, ...ids.map(id => ({id, kind: 'session' as const, title: '会话', sessionId: id}))]};
}
export function selectDockTab(dock: DockState, id: string): DockState {
  const group = groups(dock.root).find(g => g.tabs.includes(id));
  if (!group) return dock;
  if (dock.activeGroupId === group.id && group.activeId === id && dock.recent.at(-1) === id) return dock;
  return {...dock, activeGroupId: group.id, recent: touch(dock.recent, id), root: mapTree(dock.root, group.id, n => ({...n as TabGroup, activeId: id}))};
}
export function openDockTab(dock: DockState, tab: DockTab, groupId = dock.activeGroupId): DockState {
  if (dock.tabs.some(t => t.id === tab.id)) return selectDockTab(dock, tab.id);
  if (!groups(dock.root).some(g => g.id === groupId)) return dock;
  return {...dock, tabs: [...dock.tabs, tab], recent: touch(dock.recent, tab.id), activeGroupId: groupId,
    root: mapTree(dock.root, groupId, n => ({...n as TabGroup, tabs: [...(n as TabGroup).tabs, tab.id], activeId: tab.id}))};
}
export function closeDockTab(dock: DockState, id: string): DockState {
  const owner = groups(dock.root).find(g => g.tabs.includes(id));
  if (!owner || id === 'workspace') return dock;
  const tabs = owner.tabs.filter(t => t !== id);
  const recent = dock.recent.filter(t => t !== id);
  const activeId = owner.activeId !== id ? owner.activeId : [...recent].reverse().find(t => tabs.includes(t)) || tabs.at(-1) || '';
  const root = prune(mapTree(dock.root, owner.id, () => ({...owner, tabs, activeId})), owner.id)!;
  const survivors = groups(root);
  const activeGroupId = survivors.some(g => g.id === dock.activeGroupId) ? dock.activeGroupId : survivors[0].id;
  return {...dock, root, tabs: dock.tabs.filter(t => t.id !== id), recent, activeGroupId};
}
export function moveDockTab(dock: DockState, id: string, targetId: string, beforeId?: string, edge?: Edge, newId: string = crypto.randomUUID()): DockState {
  const source = groups(dock.root).find(g => g.tabs.includes(id));
  const target = groups(dock.root).find(g => g.id === targetId);
  if (!source || !target || (!edge && id === beforeId) || (edge && (groups(dock.root).length >= 8 || (source.id === targetId && source.tabs.length < 2)))) return dock;
  let root = mapTree(dock.root, source.id, n => {
    const group = n as TabGroup; const tabs = group.tabs.filter(t => t !== id);
    return {...group, tabs, activeId: group.activeId === id ? [...dock.recent].reverse().find(t => tabs.includes(t)) || tabs.at(-1) || '' : group.activeId};
  });
  root = mapTree(root, targetId, n => {
    const group = n as TabGroup;
    if (edge) {
      const added: TabGroup = {kind: 'group', id: newId, tabs: [id], activeId: id};
      const first = edge === 'left' || edge === 'top';
      return {kind: 'split', id: `split-${newId}`, axis: edge === 'left' || edge === 'right' ? 'row' : 'column', ratio: .5, children: first ? [added, group] : [group, added]};
    }
    const tabs = [...group.tabs]; const at = beforeId ? tabs.indexOf(beforeId) : -1;
    tabs.splice(at < 0 ? tabs.length : at, 0, id);
    return {...group, tabs, activeId: id};
  });
  return {...dock, root: prune(root, source.id)!, activeGroupId: edge ? newId : targetId, recent: touch(dock.recent, id)};
}
export function resizeDock(dock: DockState, id: string, ratio: number): DockState {
  if (!Number.isFinite(ratio)) return dock;
  return {...dock, root: mapTree(dock.root, id, n => n.kind === 'split' ? {...n, ratio: Math.min(.85, Math.max(.15, ratio))} : n)};
}
export function splitDockGroup(dock: DockState, groupId: string, axis: Split['axis'], id: string = crypto.randomUUID()): DockState {
  const group = groups(dock.root).find(g => g.id === groupId);
  if (!group || groups(dock.root).length >= 8) return dock;
  if (group.tabs.length > 1) return moveDockTab(dock, group.activeId, groupId, undefined, axis === 'row' ? 'right' : 'bottom', id);
  return {...dock, activeGroupId: id, root: mapTree(dock.root, groupId, n => ({kind: 'split', id: `split-${id}`, axis, ratio: .5, children: [n, {kind: 'group', id, tabs: [], activeId: ''}]}))};
}
export function closeEmptyGroup(dock: DockState, groupId: string): DockState {
  if (!groups(dock.root).some(g => g.id === groupId && !g.tabs.length)) return dock;
  const root = prune(dock.root, groupId)!;
  return {...dock, root, activeGroupId: groups(root).some(g => g.id === dock.activeGroupId) ? dock.activeGroupId : groups(root)[0].id};
}
export function mergeDock(dock: DockState): DockState {
  const all = groups(dock.root); const activeId = focusedGroup(dock).activeId || all.find(g => g.activeId)!.activeId;
  return {...dock, activeGroupId: 'main', root: {kind: 'group', id: 'main', tabs: all.flatMap(g => g.tabs), activeId}};
}
export function browserUrl(input: string): string | null {
  try {
    const value = input.trim(); if (!value) return '';
    const url = new URL(/^(?:https?):\/\//i.test(value) ? value : /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(value) ? `http://${value}` : /^[\w.-]+(?::\d+)?(?:\/|$)/.test(value) ? `https://${value}` : value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {return null;}
}
export function validateDock(value: unknown, sessionIds: string[]): asserts value is DockState {
  const fail = () => {throw new Error('分区数据无效，原始内容已保留。');};
  const dock = value as DockState;
  if (!dock || !Array.isArray(dock.tabs) || !Array.isArray(dock.recent) || !dock.root) return fail();
  const ids = new Set<string>(); const placed: string[] = []; const groupIds: string[] = [];
  function walk(node: DockNode, depth: number) {
    if (!node || depth > 8 || typeof node.id !== 'string' || !node.id || ids.has(node.id)) return fail();
    ids.add(node.id);
    if (node.kind === 'group') {
      if (!Array.isArray(node.tabs) || (node.tabs.length ? !node.tabs.includes(node.activeId) : node.activeId !== '')) return fail();
      placed.push(...node.tabs); groupIds.push(node.id);
    } else if (node.kind === 'split' && ['row', 'column'].includes(node.axis) && Number.isFinite(node.ratio) && node.ratio >= .15 && node.ratio <= .85 && Array.isArray(node.children) && node.children.length === 2) node.children.forEach(child => walk(child, depth + 1));
    else return fail();
  }
  walk(dock.root, 0);
  if (groupIds.length > 8 || !groupIds.includes(dock.activeGroupId) || new Set(placed).size !== placed.length || placed.length !== dock.tabs.length || new Set(dock.tabs.map(t => t?.id)).size !== dock.tabs.length || dock.tabs.filter(t => t.kind === 'map' && t.id === 'workspace').length !== 1) return fail();
  for (const tab of dock.tabs) {
    if (!tab || typeof tab.id !== 'string' || !tab.id || !placed.includes(tab.id) || typeof tab.title !== 'string') return fail();
    if (tab.kind === 'map') {if (tab.id !== 'workspace') return fail();}
    else if (tab.kind === 'session') {if (tab.id !== tab.sessionId || !sessionIds.includes(tab.sessionId)) return fail();}
    else if (tab.kind === 'browser') {if (typeof tab.url !== 'string' || browserUrl(tab.url) === null) return fail();}
    else if (tab.kind === 'review') {if (!Array.isArray(tab.files) || tab.files.length > 2 || tab.files.some(f => !f || typeof f.name !== 'string' || typeof f.text !== 'string' || f.text.length > 262144)) return fail();}
    else if (tab.kind === 'report') {if (typeof tab.url !== 'string' || browserUrl(tab.url) === null || typeof tab.file !== 'string' || !/^round-[\w.-]+\.json$/.test(tab.file) || tab.file.includes('..')) return fail();}
    else if (tab.kind === 'material') {if (typeof tab.nodeId !== 'string' || typeof tab.materialId !== 'string') return fail();}
    else return fail();
  }
  if (new Set(dock.recent).size !== dock.recent.length || dock.recent.some(id => !placed.includes(id))) return fail();
}
