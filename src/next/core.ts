import {contentFields, isTask, newSpace, parseState, seedState, syncTaskProgress, taskChildren, type DesignState, type MindNode, type Space} from './model';
import type {WidgetWindowRect} from '../workspace-layout';
import type {LayoutTemplate} from './composition';
import {parseIntegration,type ExternalIntegration} from './integration-manifest';
import {boundedText} from './text';
import {parseMaterialTarget} from './material-target';
import {emptyGraph, validGraph, type GraphState} from './graph-state';
export type {GraphState} from './graph-state';
import {closeDockTab, groups, initialDock, moveDockTab, openDockTab, repairBrowserIds, selectDockTab, validateDock, type DockState, type DockTab} from './docking';

export type RunState = 'running' | 'needs_input' | 'succeeded' | 'failed' | 'cancelled';
export type DemoOutcome = 'succeeded' | 'needs_input' | 'failed';
export interface Surface {id: string; integrationId: string; title: string; resourceId?: string; text?: string; url?: string}
export interface Pane {id: string; tabs: string[]; activeId: string}
export interface Workspace extends Space {
  surfaces: Surface[];
  layout: {panes: Pane[]; activePaneId: string; ratio: number};
  graph: GraphState;
  sessionPanelOpen: boolean;
  sessionWindow: {sessionId: string | null; rect: WidgetWindowRect; maximized: boolean};
  sessionTabs: {ids: string[]; activeId: string; recent: string[]};
  dock: DockState;
  cwd?: string;
  review?: {url: string} | null;
  materialRoots?: {name: string; path: string}[];
}
export interface Message {id: string; role: 'user' | 'assistant'; text: string; at: number}
export interface AgentSession {
  id: string; workspaceId: string; nodeId: string | null; integrationId: string;
  title: string; messages: Message[]; draft: string; unread: boolean; createdAt: number;
  agentId?: 'codex' | 'claude' | 'pi'; linkedNodeIds?: string[];
  cwd?: string; sourceId?: string | null; nativeRevision?: number; requests?: AgentRequest[]; connectionError?: string;
}
export interface AgentRequest {id: string; kind: string; title: string; payload: Record<string, unknown>; sourceId: unknown}
export type MapAction = 'reply' | 'progress' | 'update' | 'artifact';
export interface Run {
  id: string; sessionId: string; state: RunState; outcome?: DemoOutcome;
  startedAt: number; dueAt: number;
  mapAction?: MapAction; targetNodeId?: string;
  error?: string | null;
  stopping?: boolean;
  context?: string;
}
export interface Artifact {id: string; sessionId: string; runId: string; title: string; text: string}
export type NoticeTarget = {kind: 'session'; sessionId: string} | {kind: 'report'; url: string; file: string} | {kind: 'workspace'};
export interface Notice {id: string; runId?: string; workspaceId: string; sessionId?: string; target?: NoticeTarget; title: string; body?: string; read: boolean; at: number}
export function reviewUrl(value: string): string | null {
  try {const url = new URL(value.trim()); return url.protocol === 'http:' && /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url.href : null;} catch {return null;}
}
export interface WorkbenchState {
  version: 2; activeId: string; spaces: Workspace[];
  graphCursor?: number;
  templates?: LayoutTemplate[];
  externalIntegrations?: ExternalIntegration[];
  sessions: AgentSession[]; runs: Run[]; artifacts: Artifact[]; notices: Notice[];
}
export const shellStorageKey = 'northstar-shell-v2';
export const previousShellStorageKey = 'northstar-shell-v1';
export const defaultSessionWindow = () => ({sessionId: null as string | null, rect: {x: 70, y: 52, width: 660, height: 420}, maximized: false});
export const sessionNodeIds = (session: AgentSession) => [...new Set([...(session.nodeId ? [session.nodeId] : []), ...(session.linkedNodeIds || [])])];

export function workspaceFrom(space: Space): Workspace {
  const surfaces = space.components.map((kind, index): Surface => ({
    id: `${space.id}-view-${index}`, integrationId: {map: 'graph', events: 'tasks', notes: 'note', web: 'web'}[kind],
    title: {map: '思维导图', events: '任务', notes: '笔记', web: '网页工具'}[kind],
    ...(kind === 'notes' ? {text: space.notes} : {}), ...(kind === 'web' ? {url: space.website} : {}),
  }));
  return {...space, review: space.website === 'http://127.0.0.1:8765/' ? {url: space.website} : null, surfaces, layout: {panes: [{id: 'main', tabs: surfaces.map(s => s.id), activeId: surfaces[0].id}], activePaneId: 'main', ratio: .5}, graph: {selectedId: null, focusId: null, collapsed: [], camera: null}, sessionPanelOpen: false, sessionWindow: defaultSessionWindow(), sessionTabs: {ids: [], activeId: 'workspace', recent: ['workspace']}, dock: initialDock()};
}
export function createWorkspace(name: string, preset: 'blank' | 'project' | 'web') {return workspaceFrom(newSpace(name, preset));}
export function initialWorkbench(legacy: DesignState = seedState()): WorkbenchState {
  return {version: 2, activeId: legacy.activeId, spaces: legacy.spaces.map(workspaceFrom), sessions: [], runs: [], artifacts: [], notices: []};
}

export function updateWorkspace(state: WorkbenchState, id: string, update: (space: Workspace) => Workspace): WorkbenchState {
  return {...state, spaces: state.spaces.map(space => {if (space.id !== id) return space;const next = update(space);return next.nodes === space.nodes ? next : {...next, nodes: syncTaskProgress(next.nodes)};})};
}
export function editNodeContent(state: WorkbenchState, workspaceId: string, nodeId: string, value: string): WorkbenchState {
  const fields = contentFields(value); const node = state.spaces.find(w => w.id === workspaceId)?.nodes.find(n => n.id === nodeId);
  if (!fields || !node || (fields.title === node.title && fields.body === node.body)) return state;
  return updateWorkspace(state, workspaceId, w => ({...w, nodes: w.nodes.map(n => n.id === nodeId ? {...n, ...fields} : n)}));
}
export function setNodeTask(state: WorkbenchState, workspaceId: string, nodeId: string, enabled: boolean): WorkbenchState {
  return updateWorkspace(state, workspaceId, w => ({...w, nodes: w.nodes.map(n => n.id === nodeId ? {...n, kind: n.kind === 'event' ? 'idea' : n.kind, task: enabled} : n)}));
}
export function addSubtask(state: WorkbenchState, workspaceId: string, parentId: string, id: string): WorkbenchState {
  const space = state.spaces.find(w => w.id === workspaceId);const parent = space?.nodes.find(n => n.id === parentId);
  if (!space || !parent || space.nodes.length >= 250 || space.nodes.some(n => n.id === id)) return state;
  const child: MindNode = {id, parentId, side: parent.side, kind: 'idea', title: '新节点', body: '', task: true, progress: 0, due: ''};
  return updateWorkspace(state, workspaceId, w => ({...w, nodes: [...w.nodes.map(n => n.id === parentId ? {...n, task: true} : n), child]}));
}
export function setTaskProgress(state: WorkbenchState, workspaceId: string, nodeId: string, progress: number): WorkbenchState {
  const space = state.spaces.find(w => w.id === workspaceId);const node = space?.nodes.find(n => n.id === nodeId);
  if (!space || !node || !isTask(node) || taskChildren(space.nodes, nodeId).length || !Number.isFinite(progress)) return state;
  return updateWorkspace(state, workspaceId, w => ({...w, nodes: w.nodes.map(n => n.id === nodeId ? {...n, progress: Math.min(100, Math.max(0, progress))} : n)}));
}
export function mapGraph(space: Workspace, tabId = 'workspace'): GraphState {
  const tab = space.dock.tabs.find(t => t.id === tabId);
  return tab?.kind === 'map' && tab.id !== 'workspace' ? tab.graph! : space.graph;
}
export function updateMapGraph(space: Workspace, graph: GraphState, tabId = 'workspace'): Workspace {
  if (tabId === 'workspace') return {...space, graph};
  return {...space, dock: {...space.dock, tabs: space.dock.tabs.map(tab => tab.id === tabId && tab.kind === 'map' ? {...tab, graph} : tab)}};
}
export function openMapTab(space: Workspace, groupId: string, id: string): Workspace {
  return {...space, dock: openDockTab(space.dock, {id, kind: 'map', title: '思维导图', graph: emptyGraph()}, groupId)};
}
function migrateMaterialTabs(dock: DockState, oldSpace: Workspace, space: Workspace): DockState {
  return {...dock, tabs: dock.tabs.map((tab): DockTab => {
    if (tab.kind !== 'material') return tab;
    const old = oldSpace.nodes.find(n => n.id === tab.nodeId) as (MindNode & {reference?: string}) | undefined;
    const target = (tab.materialId === 'legacy-reference' ? old?.reference : undefined) || old?.materials?.find(m => m.id === tab.materialId)?.target;
    if (!target) return tab;
    try {const canonical = parseMaterialTarget(target).target;const material = space.nodes.find(n => n.id === tab.nodeId)?.materials?.find(m => m.target === canonical);return material ? {...tab, materialId: material.id} : tab;}
    catch {return {id:tab.id,title:tab.title,kind:'map',graph:{...emptyGraph(),selectedId:tab.nodeId}};}
  })};
}
export function createMapNode(state: WorkbenchState, workspaceId: string, parentId: string, id: string, tabId = 'workspace'): WorkbenchState {
  const space = state.spaces.find(w => w.id === workspaceId);
  if (!space || !space.dock.tabs.some(t => t.id === tabId && t.kind === 'map') || space.nodes.length >= 250 || !space.nodes.some(n => n.id === parentId) || space.nodes.some(n => n.id === id)) return state;
  return updateWorkspace(state, workspaceId, w => {
    const graph = mapGraph(w, tabId);
    return updateMapGraph({...w, nodes: [...w.nodes, {id, parentId, side: 1, kind: 'idea', title: '新节点', body: '', progress: 0, due: ''}]}, {...graph, selectedId: id, focusId: null, collapsed: graph.collapsed.filter(value => value !== parentId), camera: null}, tabId);
  });
}
export function addSurface(space: Workspace, surface: Surface): Workspace {
  if (space.layout.panes.some(p => p.tabs.includes(surface.id))) return space;
  const paneId = space.layout.activePaneId;
  return {...space, surfaces: space.surfaces.some(s => s.id === surface.id) ? space.surfaces : [...space.surfaces, surface], layout: {...space.layout, panes: space.layout.panes.map(pane => pane.id === paneId ? {...pane, tabs: [...pane.tabs, surface.id], activeId: surface.id} : pane)}};
}
export function closeSurface(space: Workspace, id: string): Workspace {
  const panes = space.layout.panes.map(pane => {
    const index = pane.tabs.indexOf(id);
    const tabs = pane.tabs.filter(tab => tab !== id);
    return {...pane, tabs, activeId: pane.activeId === id ? tabs[Math.max(0, index - 1)] || '' : pane.activeId};
  }).filter(pane => pane.tabs.length);
  const next = panes.length ? panes : [{id: 'main', tabs: [], activeId: ''}];
  return {...space, layout: {...space.layout, panes: next, activePaneId: next.some(p => p.id === space.layout.activePaneId) ? space.layout.activePaneId : next[0].id}};
}
export function splitSurface(space: Workspace, id: string): Workspace {
  if (space.layout.panes.length !== 1 || space.layout.panes[0].tabs.length < 2) return space;
  const original = space.layout.panes[0];
  const tabs = original.tabs.filter(tab => tab !== id);
  return {...space, layout: {ratio: .5, activePaneId: 'secondary', panes: [{...original, tabs, activeId: original.activeId === id ? tabs[0] : original.activeId}, {id: 'secondary', tabs: [id], activeId: id}]}};
}
export function mergePanes(space: Workspace): Workspace {
  const tabs = space.layout.panes.flatMap(p => p.tabs);
  const activeId = space.layout.panes.find(p => p.id === space.layout.activePaneId)!.activeId;
  return {...space, layout: {panes: [{id: 'main', tabs, activeId}], activePaneId: 'main', ratio: .5}};
}
export function moveSurface(space: Workspace, id: string, targetPaneId: string, beforeId?: string): Workspace {
  if (!space.layout.panes.some(p => p.tabs.includes(id)) || !space.layout.panes.some(p => p.id === targetPaneId) || id === beforeId) return space;
  const panes = space.layout.panes.map(p => {
    const index = p.tabs.indexOf(id);
    const tabs = p.tabs.filter(tab => tab !== id);
    let activeId = p.activeId === id ? tabs[Math.max(0, index - 1)] || '' : p.activeId;
    if (p.id === targetPaneId) {
      const insertion = beforeId ? tabs.indexOf(beforeId) : -1;
      tabs.splice(insertion < 0 ? tabs.length : insertion, 0, id);
      activeId = id;
    }
    return {...p, tabs, activeId};
  }).filter(p => p.tabs.length);
  return {...space, layout: {...space.layout, panes, activePaneId: targetPaneId}};
}

export function openSession(state: WorkbenchState, sessionId: string): WorkbenchState {
  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) return state;
  let next = updateWorkspace(state, session.workspaceId, space => ({...space, dock: openDockTab(space.dock, {id: sessionId, kind: 'session', sessionId, title: session.title}), sessionTabs: {ids: space.sessionTabs.ids.includes(sessionId) ? space.sessionTabs.ids : [...space.sessionTabs.ids, sessionId], activeId: sessionId, recent: [...space.sessionTabs.recent.filter(id => id !== sessionId), sessionId]}}));
  next = {...next, activeId: session.workspaceId, sessions: next.sessions.map(s => s.id === sessionId ? {...s, unread: false} : s), notices: next.notices.map(n => n.sessionId === sessionId ? {...n, read: true} : n)};
  return next;
}
export function selectWorkspaceTab(state: WorkbenchState, workspaceId: string): WorkbenchState {
  return {...updateWorkspace(state, workspaceId, space => ({...space, dock: selectDockTab(space.dock, 'workspace'), sessionTabs: {...space.sessionTabs, activeId: 'workspace', recent: [...space.sessionTabs.recent.filter(id => id !== 'workspace'), 'workspace']}})), activeId: workspaceId};
}
export function closeSessionTab(state: WorkbenchState, workspaceId: string, sessionId: string): WorkbenchState {
  const space = state.spaces.find(w => w.id === workspaceId);
  if (!space || !space.sessionTabs.ids.includes(sessionId)) return state;
  const ids = space.sessionTabs.ids.filter(id => id !== sessionId);
  const recent = space.sessionTabs.recent.filter(id => id !== sessionId);
  const activeId = space.sessionTabs.activeId === sessionId ? recent.at(-1) || ids.at(-1) || 'workspace' : space.sessionTabs.activeId;
  return updateWorkspace(state, workspaceId, w => ({...w, dock: closeDockTab(w.dock, sessionId), sessionTabs: {ids, recent, activeId}}));
}
export function reorderSessionTab(space: Workspace, sessionId: string, beforeId?: string): Workspace {
  if (!space.sessionTabs.ids.includes(sessionId) || sessionId === beforeId || (beforeId && !space.sessionTabs.ids.includes(beforeId))) return space;
  const ids = space.sessionTabs.ids.filter(id => id !== sessionId);
  ids.splice(beforeId ? ids.indexOf(beforeId) : ids.length, 0, sessionId);
  const owner = groups(space.dock.root).find(g => g.tabs.includes(sessionId));
  return {...space, dock: owner ? moveDockTab(space.dock, sessionId, owner.id, beforeId) : space.dock, sessionTabs: {...space.sessionTabs, ids}};
}
export function activateSurface(state: WorkbenchState, workspaceId: string, surfaceId: string): WorkbenchState {
  const space = state.spaces.find(s => s.id === workspaceId);
  const surface = space?.surfaces.find(s => s.id === surfaceId);
  if (!space || !surface) return state;
  if (surface.integrationId === 'session' && surface.resourceId) return openSession(state, surface.resourceId);
  const pane = space.layout.panes.find(p => p.tabs.includes(surfaceId));
  if (!pane) return state;
  return {...updateWorkspace(state, workspaceId, s => ({...s, layout: {...s.layout, activePaneId: pane.id, panes: s.layout.panes.map(p => p.id === pane.id ? {...p, activeId: surfaceId} : p)}})), activeId: workspaceId};
}
export function createSession(state: WorkbenchState, workspaceId: string, nodeId: string | null, id: string, at: number, agentId: AgentSession['agentId'] = 'codex', name?: string): WorkbenchState {
  const space = state.spaces.find(s => s.id === workspaceId)!;
  const node = space.nodes.find(n => n.id === nodeId);
  const base = name?.trim() || (node ? `${node.title} · 讨论` : '新的会话');
  const count = state.sessions.filter(s => s.workspaceId === workspaceId && s.nodeId === nodeId).length;
  const session: AgentSession = {id, workspaceId, nodeId: node?.id || null, integrationId: 'demo-agent', agentId, title: count && !name?.trim() ? `${base} ${count + 1}` : base, messages: [], draft: '', unread: false, createdAt: at};
  return openSession({...state, sessions: [...state.sessions, session]}, id);
}
export function startDemoRun(state: WorkbenchState, sessionId: string, text: string, outcome: DemoOutcome, runId: string, at: number, mapAction: MapAction = 'reply', targetNodeId?: string): WorkbenchState {
  const session = state.sessions.find(s => s.id === sessionId);
  if ((mapAction === 'progress' || mapAction === 'update') && !state.spaces.find(w => w.id === session?.workspaceId)?.nodes.some(n => n.id === targetNodeId)) return state;
  if (!text.trim() || !state.sessions.some(s => s.id === sessionId && s.integrationId === 'demo-agent') || state.runs.some(r => r.sessionId === sessionId && (r.state === 'running' || r.state === 'needs_input'))) return state;
  return {...state,
    sessions: state.sessions.map(s => s.id === sessionId ? {...s, ...(!s.messages.length && /^新的会话(?: \d+)?$/.test(s.title) ? {title: boundedText(text.trim().split('\n')[0],32)} : {}), draft: '', messages: [...s.messages, {id: `${runId}-user`, role: 'user', text: text.trim(), at}]} : s),
    runs: [...state.runs, {id: runId, sessionId, state: 'running', outcome, startedAt: at, dueAt: at + 7000, mapAction, targetNodeId}],
  };
}
export function resumeDemoRun(state: WorkbenchState, runId: string, at: number): WorkbenchState {
  const run = state.runs.find(r => r.id === runId && r.state === 'needs_input');
  if (!run) return state;
  return {...state, runs: state.runs.map(r => r.id === runId ? {...r, state: 'running', outcome: 'succeeded', dueAt: at + 4000} : r), sessions: state.sessions.map(s => s.id === run.sessionId ? {...s, unread: false} : s), notices: state.notices.map(n => n.runId === runId ? {...n, read: true} : n)};
}
export function cancelDemoRun(state: WorkbenchState, runId: string): WorkbenchState {
  const run = state.runs.find(r => r.id === runId && (r.state === 'running' || r.state === 'needs_input'));
  if (!run) return state;
  return {...state, runs: state.runs.map(r => r.id === runId ? {...r, state: 'cancelled'} : r), sessions: state.sessions.map(s => s.id === run.sessionId ? {...s, unread: false} : s), notices: state.notices.map(n => n.runId === runId ? {...n, read: true} : n)};
}
export function advanceDemoRuns(state: WorkbenchState, at: number): WorkbenchState {
  const due = state.runs.filter(r => r.state === 'running' && r.dueAt <= at && state.sessions.some(s => s.id === r.sessionId && s.integrationId === 'demo-agent'));
  if (!due.length) return state;
  let next = state;
  for (const run of due) {
    const outcome = run.outcome || 'failed';
    const session = next.sessions.find(s => s.id === run.sessionId)!;
    const title = outcome === 'succeeded' ? '模拟执行完成' : outcome === 'needs_input' ? '模拟执行需要输入' : '模拟执行失败';
    const reply = outcome === 'succeeded'
      ? '模拟执行已完成，会话记录和结果已保存。\n\n这是骨架阶段的固定示例回复，没有启动真实 Agent，也没有读取或修改项目文件。需要保留时，可以把结果放到地图。'
      : outcome === 'needs_input' ? '模拟 Agent 正在等待你的输入。点击“继续模拟”后会完成本轮。' : '模拟了适配器返回失败的情况。你可以发送新消息重新验证流程。';
    next = {...next, runs: next.runs.map(r => r.id === run.id ? {...r, state: outcome} : r),
      sessions: next.sessions.map(s => s.id === session.id ? {...s, unread: true, messages: [...s.messages, {id: `${run.id}-${run.outcome}`, role: 'assistant', text: reply, at}]} : s),
      artifacts: outcome === 'succeeded' ? [...next.artifacts, {id: `${run.id}-artifact`, sessionId: session.id, runId: run.id, title: '骨架流程验证记录（模拟）', text: reply}] : next.artifacts,
      notices: [...next.notices.filter(n => n.id !== `${run.id}-notice`), {id: `${run.id}-notice`, runId: run.id, workspaceId: session.workspaceId, sessionId: session.id, title, read: false, at}],
    };
    if (run.outcome === 'succeeded') next = applyRunMapChange(next, run.id, at);
  }
  return next;
}
export function closeSessionWindow(state: WorkbenchState, workspaceId: string) {
  return updateWorkspace(state, workspaceId, space => ({...space, sessionWindow: {...space.sessionWindow, sessionId: null}}));
}
export function placeArtifact(state: WorkbenchState, artifactId: string, at: number): WorkbenchState {
  const artifact = state.artifacts.find(a => a.id === artifactId);
  const session = state.sessions.find(s => s.id === artifact?.sessionId);
  if (!artifact || !session) return state;
  const workspace = state.spaces.find(w => w.id === session.workspaceId)!;
  const existing = workspace.nodes.find(n => n.sourceArtifactId === artifact.id);
  if (!existing && workspace.nodes.length >= 250) return state;
  const nodeId = existing?.id || `artifact-${artifact.id}`;
  const next = updateWorkspace(state, session.workspaceId, space => {
    if (space.nodes.length >= 250 || space.nodes.some(n => n.sourceArtifactId === artifact.id)) return space;
    const parent = space.nodes.find(n => n.id === session.nodeId) || space.nodes.find(n => !n.parentId)!;
    return {...space, nodes: [...space.nodes, {id: `artifact-${artifact.id}`, parentId: parent.id, side: parent.side, kind: 'artifact', title: boundedText(artifact.title,120)||'产物', body: artifact.text, progress: 0, due: '', sourceArtifactId: artifact.id, updates: [{id: `created-${artifact.id}`, text: session.integrationId === 'demo-agent' ? '从会话保留产物（模拟结果）' : '从会话保留产物', at, sessionId: session.id}]}], graph: {...space.graph, collapsed: space.graph.collapsed.filter(id => id !== parent.id)}};
  });
  return {...next, sessions: next.sessions.map(s => s.id === session.id ? {...s, linkedNodeIds: [...new Set([...(s.linkedNodeIds || []), nodeId])]} : s)};
}
export function applyRunMapChange(state: WorkbenchState, runId: string, at: number): WorkbenchState {
  const run = state.runs.find(r => r.id === runId && r.state === 'succeeded');
  const session = state.sessions.find(s => s.id === run?.sessionId);
  if (!run || !session || !run.mapAction || run.mapAction === 'reply') return state;
  if (run.mapAction === 'artifact') return placeArtifact(state, `${run.id}-artifact`, at);
  return updateWorkspace(state, session.workspaceId, space => ({...space, nodes: space.nodes.map(node => {
    if (node.id !== run.targetNodeId || node.updates?.some(u => u.id === `${run.id}-map`)) return node;
    const text = run.mapAction === 'update' ? '模拟更新：已整理本节点的目标、约束和下一步。' : '模拟进展：已完成一次会话执行，结果可从关联会话查看。';
    return {...node, ...(run.mapAction === 'update' ? {body: `${node.body}${node.body ? '\n\n' : ''}${text}`} : {}), updates: [...(node.updates || []), {id: `${run.id}-map`, text, at, sessionId: session.id}]};
  })}));
}
export const latestRun = (state: WorkbenchState, sessionId: string) => [...state.runs].reverse().find(r => r.sessionId === sessionId);
export const statusNames: Record<RunState | 'idle', string> = {idle: '未开始', running: '运行中', needs_input: '需要输入', succeeded: '已完成', failed: '失败', cancelled: '已停止'};

export function parseWorkbench(value: unknown): WorkbenchState {
  const raw = structuredClone(value) as WorkbenchState;
  const fail = () => {throw new Error('工作台数据无效，原始内容已保留。');};
  if (!raw || ![1, 2].includes(raw.version) || !Array.isArray(raw.sessions) || !Array.isArray(raw.runs) || !Array.isArray(raw.artifacts) || !Array.isArray(raw.notices)) return fail();
  if (raw.graphCursor !== undefined && (!Number.isSafeInteger(raw.graphCursor) || raw.graphCursor < 0)) return fail();
  if(raw.templates!==undefined){if(!Array.isArray(raw.templates)||raw.templates.length>30||new Set(raw.templates.map(t=>t.id)).size!==raw.templates.length)return fail();for(const template of raw.templates){if(!template || typeof template.id!=='string' || typeof template.name!=='string' || !template.name.trim() || template.dock.tabs.some(t=>!['map','events','business','review','browser'].includes(t.kind)))return fail();validateDock(template.dock,[]);}}
  if(raw.externalIntegrations!==undefined){if(!Array.isArray(raw.externalIntegrations)||raw.externalIntegrations.length>30||new Set(raw.externalIntegrations.map(i=>i.id)).size!==raw.externalIntegrations.length)return fail();raw.externalIntegrations.forEach(parseIntegration);}
  const oldSpaces = raw.spaces;
  raw.spaces = parseState({version: 2, activeId: raw.activeId, spaces: raw.spaces}).spaces as Workspace[];
  const browserIds=new Set<string>();
  const state: WorkbenchState = {...raw, version: 2, spaces: raw.spaces.map(space => {
    const activeTab = space.layout?.panes?.find(p => p.id === space.layout.activePaneId)?.activeId;
    const legacySession = space.surfaces?.find(s => s.id === activeTab && s.integrationId === 'session')?.resourceId;
    const window = space.sessionWindow ?? {...defaultSessionWindow(), sessionId: legacySession || null};
    const sessionTabs = space.sessionTabs ?? {ids: window.sessionId ? [window.sessionId] : [], activeId: window.sessionId || 'workspace', recent: window.sessionId ? ['workspace', window.sessionId] : ['workspace']};
    return {...space, review: space.review === undefined && space.website === 'http://127.0.0.1:8765/' ? {url: space.website} : space.review ?? null, graph: {...space.graph, ...((raw.version as number) === 1 ? {camera: null} : {})}, sessionPanelOpen: space.sessionPanelOpen ?? false, sessionWindow: window, sessionTabs, dock: migrateMaterialTabs(repairBrowserIds(space.dock ?? initialDock(sessionTabs.ids, sessionTabs.activeId, sessionTabs.recent),browserIds), oldSpaces.find(w=>w.id===space.id)!, space)};
  })};
  parseState({version: 2, activeId: state.activeId, spaces: state.spaces});
  const unique = (items: {id: string}[]) => items.every(i => i && typeof i.id === 'string' && i.id.length > 0) && new Set(items.map(i => i.id)).size === items.length;
  if (![state.sessions, state.runs, state.artifacts, state.notices].every(unique)) return fail();
  for (const space of state.spaces) {
    validateDock(space.dock, state.sessions.filter(s => s.workspaceId === space.id).map(s => s.id));
    if (!Array.isArray(space.surfaces) || !unique(space.surfaces) || !space.layout || !Array.isArray(space.layout.panes) || space.layout.panes.length < 1 || space.layout.panes.length > 2 || !unique(space.layout.panes) || !space.layout.panes.some(p => p.id === space.layout.activePaneId) || !Number.isFinite(space.layout.ratio) || space.layout.ratio < .25 || space.layout.ratio > .75) return fail();
    const allTabs = space.layout.panes.flatMap(p => Array.isArray(p.tabs) ? p.tabs : []);
    if (new Set(allTabs).size !== allTabs.length || allTabs.some(t => !space.surfaces.some(s => s.id === t))) return fail();
    for (const pane of space.layout.panes) if (!Array.isArray(pane.tabs) || (pane.tabs.length ? !pane.tabs.includes(pane.activeId) : pane.activeId !== '')) return fail();
    for (const surface of space.surfaces) if (typeof surface.integrationId !== 'string' || typeof surface.title !== 'string' || (surface.text !== undefined && typeof surface.text !== 'string') || (surface.url !== undefined && typeof surface.url !== 'string') || (surface.integrationId === 'session' && !state.sessions.some(s => s.id === surface.resourceId && s.workspaceId === space.id))) return fail();
    if (space.cwd !== undefined && typeof space.cwd !== 'string') return fail();
    if (space.review != null && (typeof space.review.url !== 'string' || !reviewUrl(space.review.url))) return fail();
    if (space.materialRoots !== undefined && (!Array.isArray(space.materialRoots) || space.materialRoots.length > 20 || space.materialRoots.some(root => !root || typeof root.name !== 'string' || !root.name.trim() || typeof root.path !== 'string' || !root.path.trim()))) return fail();
    const window = space.sessionWindow;
    const tabs = space.sessionTabs;
    if (!tabs || !Array.isArray(tabs.ids) || new Set(tabs.ids).size !== tabs.ids.length || tabs.ids.some(id => !state.sessions.some(s => s.id === id && s.workspaceId === space.id)) || (tabs.activeId !== 'workspace' && !tabs.ids.includes(tabs.activeId)) || !Array.isArray(tabs.recent) || new Set(tabs.recent).size !== tabs.recent.length || tabs.recent.some(id => id !== 'workspace' && !tabs.ids.includes(id))) return fail();
    if (typeof space.sessionPanelOpen !== 'boolean' || !window || typeof window.maximized !== 'boolean' || !window.rect || ![window.rect.x, window.rect.y, window.rect.width, window.rect.height].every(Number.isFinite) || window.rect.width < 160 || window.rect.height < 160 || (window.sessionId !== null && !state.sessions.some(s => s.id === window.sessionId && s.workspaceId === space.id))) return fail();
    const nodeIds = space.nodes.map(n => n.id);
    if (!validGraph(space.graph, nodeIds) || space.dock.tabs.some(tab => tab.kind === 'map' && tab.graph !== undefined && !validGraph(tab.graph, nodeIds))) return fail();
  }
  for (const session of state.sessions) {
    const space = state.spaces.find(s => s.id === session.workspaceId);
    if ((session.cwd !== undefined && typeof session.cwd !== 'string') || (session.sourceId != null && typeof session.sourceId !== 'string') || (session.nativeRevision !== undefined && (!Number.isInteger(session.nativeRevision) || session.nativeRevision < 1)) || (session.connectionError !== undefined && typeof session.connectionError !== 'string') || (session.requests !== undefined && (!Array.isArray(session.requests) || session.requests.some(request => !request || typeof request.id !== 'string' || typeof request.kind !== 'string' || typeof request.title !== 'string' || !request.payload || typeof request.payload !== 'object')))) return fail();
    if (!space || (session.nodeId !== null && !space.nodes.some(n => n.id === session.nodeId)) || typeof session.integrationId !== 'string' || typeof session.title !== 'string' || typeof session.draft !== 'string' || typeof session.unread !== 'boolean' || !Number.isFinite(session.createdAt) || !Array.isArray(session.messages) || !unique(session.messages) || session.messages.some(m => !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string' || !Number.isFinite(m.at))) return fail();
    if ((session.agentId !== undefined && !['codex', 'claude', 'pi'].includes(session.agentId)) || (session.linkedNodeIds !== undefined && (!Array.isArray(session.linkedNodeIds) || session.linkedNodeIds.some(id => !space.nodes.some(n => n.id === id))))) return fail();
  }
  for (const run of state.runs) {
    if (run.context !== undefined && typeof run.context !== 'string') return fail();
    const session = state.sessions.find(s => s.id === run.sessionId);
    if ((run.error != null && typeof run.error !== 'string') || !session || !Object.hasOwn(statusNames, run.state) || run.state === ('idle' as string) || (run.outcome !== undefined ? !['succeeded', 'needs_input', 'failed'].includes(run.outcome) : session.integrationId === 'demo-agent') || !Number.isFinite(run.startedAt) || !Number.isFinite(run.dueAt) || (run.mapAction !== undefined && !['reply', 'progress', 'update', 'artifact'].includes(run.mapAction)) || (run.targetNodeId !== undefined && !state.spaces.find(w => w.id === session.workspaceId)?.nodes.some(n => n.id === run.targetNodeId))) return fail();
  }
  for (const session of state.sessions) if (state.runs.filter(r => r.sessionId === session.id && ['running', 'needs_input'].includes(r.state)).length > 1) return fail();
  for (const artifact of state.artifacts) if (!state.runs.some(r => r.id === artifact.runId && r.sessionId === artifact.sessionId) || typeof artifact.title !== 'string' || typeof artifact.text !== 'string') return fail();
  for (const notice of state.notices) {
    if (!state.spaces.some(s => s.id === notice.workspaceId) || typeof notice.title !== 'string' || typeof notice.read !== 'boolean' || !Number.isFinite(notice.at) || (notice.body !== undefined && typeof notice.body !== 'string')) return fail();
    if (notice.target) {const target = notice.target; if (target.kind === 'session') {if (typeof target.sessionId !== 'string') return fail();} else if (target.kind === 'report') {if (typeof target.url !== 'string' || !reviewUrl(target.url) || typeof target.file !== 'string' || !/^round-[\w.-]+\.json$/.test(target.file) || target.file.includes('..')) return fail();} else if (target.kind !== 'workspace') return fail();}
    else if (!state.sessions.some(s => s.id === notice.sessionId && s.workspaceId === notice.workspaceId) || !state.runs.some(r => r.id === notice.runId && r.sessionId === notice.sessionId)) return fail();
  }
  return state;
}
