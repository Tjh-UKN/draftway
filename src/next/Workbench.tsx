import {useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {ArrowDown, ArrowUp, BookOpen, Bell, ChevronDown, ChevronRight, CircleAlert, FolderInput, FolderOpen, FolderPlus, Globe, LayoutGrid, MessagesSquare, MessageSquare, Pencil, Plus, Search, Settings2, Terminal, Trash2, Puzzle, X} from 'lucide-react';
import {AppearancePicker} from '../AppearancePicker';
import {useAppearance} from '../appearance';
import {addSubtask, closeSessionTab, createMapNode, createSession, createWorkspace, initialWorkbench, mapGraph, openMapTab, openSession, selectWorkspaceTab, parseWorkbench, previousShellStorageKey, reviewUrl, editNodeBody, renameMapNode, sessionNodeIds, shellStorageKey, updateMapGraph, updateWorkspace, type AgentSession, type GraphState, type Notice, type Workspace, type WorkbenchState} from './core';
import {reconcileSessions} from './adapters';
import {GraphView, NodeGlyph, NodeInspector, NodeOverview, TasksView} from './Graph';
import {mapEditorReducer,initialMapEditor} from './map-editor';
import {clipboardNodes,copyMapBranch,createMapSibling,deleteMapBranch,moveMapBranch,pasteMapBranch,type NodeClipboard} from './node-operations';
import {agentNames, integrations} from './integrations';
import {hasLegacyNodePrimitives, nodeMigrationBackupKey, parseState, storageKey, type MindNode} from './model';
import {SessionRow, SessionView, type ChangeState} from './Sessions';
import {DockLayout} from './DockLayout';
import {BrowserView, ReviewView} from './ToolViews';
import {closeDockTab, focusedGroup, openDockTab, selectDockTab, type DockTab} from './docking';
import {BackendPicker} from './BackendPicker';
import {NodeMaterials} from './NodeMaterials';
import {useWorkbenchPersistence} from './persistence';
import {useNativeBrowserHost} from './native-browser';
import {AgentRuntimeContext, modelCatalogDirectory, useAgentRuntime, useNativeAgents} from './NativeAgents';
import {useNativeBackground} from './NativeBackground';
import {ReportView} from './ReportView';
import {MaterialView} from './MaterialView';
import {parseMaterialTarget, type NodeMaterial} from './material-target';
import {isHtmlReport, openLocalReport} from './local-report';
import type {SessionMaterial} from './session-materials';
import {useMapOperations} from './map-operations';
import {BusinessView} from './BusinessView';
import {useKnowledgeCollection} from './KnowledgeCollection';
const personalKnowledgeTab:Extract<DockTab,{kind:'business'}>={id:'knowledge',kind:'business',page:'knowledge',title:'个人知识库'};
import {businessComponents,isBusinessPage,type BusinessPage} from '../business-components';
import {fromTemplate,layoutTemplate} from './composition';
import {CompositionSettings} from './CompositionSettings';
import {PluginManagerDialog} from '../plugins/PluginManager';
import {boundedText} from './text';
import {Dialog, Empty, Star} from './ui';

import {WorkspaceEntry} from './WorkspaceEntry';
import {MoveWorkspaceDialog, WorkspaceGroupDialog, WorkspaceGroupEntry, WorkspaceGroupField} from './WorkspaceGroups';
import {dissolveWorkspaceGroup, expandWorkspaceGroup, moveWorkspaceGroup, moveWorkspaceToGroup, updateWorkspaceGroup, workspaceGroupOf, type WorkspaceGroup} from './workspace-groups';
import {useWorkspaceDrag} from './workspace-drag';
import {ManagementMenu, type ManagementAction} from './ManagementMenu';
import {assertSessionsIdle, deleteSessions, deleteWorkspace, renameSession} from './session-management';
import {DeleteDialog, RenameSessionDialog, SessionManagement} from './SessionManagement';
import {LocalServices, type LocalService} from './LocalServices';
import {RoomDialog} from './RoomDialog';
import {DesktopWindowControls} from './DesktopWindowControls';

type WorkbenchMenu = {x: number; y: number; keyboard?: boolean} & (
  {kind: 'create'; trigger: HTMLButtonElement} |
  {kind: 'workspace' | 'session' | 'group'; id: string; name: string}
);

function freshWorkbench(){const space=createWorkspace('我的工作区','blank');return initialWorkbench({version:2,activeId:space.id,spaces:[space]});}
function loadWorkbench() {
  try {
    const raw = localStorage.getItem(shellStorageKey) || localStorage.getItem(previousShellStorageKey);
    if (raw) {const value=JSON.parse(raw);const state=parseWorkbench(value);if(hasLegacyNodePrimitives(value)&&localStorage.getItem(nodeMigrationBackupKey)===null)localStorage.setItem(nodeMigrationBackupKey,raw);return {state,error:''};}
    const legacy = localStorage.getItem(storageKey);
    if(legacy){const value=JSON.parse(legacy);const state=initialWorkbench(parseState(value));if(hasLegacyNodePrimitives(value)&&localStorage.getItem(nodeMigrationBackupKey)===null)localStorage.setItem(nodeMigrationBackupKey,legacy);return {state,error:''};}
    return {state:freshWorkbench(),error:''};
  } catch {return {state: freshWorkbench(), error: '无法读取已保存的数据。本次使用临时状态，原始内容不会被覆盖。'};}
}
export default function Workbench() {
  const appearance = useAppearance();
  const [loaded] = useState(loadWorkbench);
  const [editor,dispatch]=useReducer(mapEditorReducer,loaded.state,initialMapEditor);
  const state=editor.state;
  const nodeClipboard=useRef<NodeClipboard|null>(null);
  const current = useRef(state); current.current = state;
  const recentSwitch = useRef<{workspaceId: string; ids: string[]; index: number} | null>(null);
  const [dialog, setDialog] = useState<'workspace' | 'settings' | 'plugins' | 'search' | 'link' | 'customize' | 'localServices' | 'room' | null>(null);
  const [newNodeId, setNewNodeId] = useState<string | null>(null);
  const [inbox, setInbox] = useState(false);
  const [managementMenu, setManagementMenu] = useState<WorkbenchMenu | null>(null);
  const [renamingSession, setRenamingSession] = useState<AgentSession | null>(null);
  const [renamingWorkspace, setRenamingWorkspace] = useState<Workspace | null>(null);
  const [workspaceCreationGroup, setWorkspaceCreationGroup] = useState('');
  const [groupEditor, setGroupEditor] = useState<{id?: string} | null>(null);
  const [movingWorkspaceId, setMovingWorkspaceId] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<{kind: 'workspace' | 'session'; id: string; name: string} | null>(null);
  const [knowledgeOpen,setKnowledgeOpen]=useState(false);
  const [knowledgeVisited,setKnowledgeVisited]=useState(false);
  const space = state.spaces.find(s => s.id === state.activeId)!;
  const workspaceGroups = state.workspaceGroups ?? [];
  const movingWorkspace = state.spaces.find(item => item.id === movingWorkspaceId);
  const editingGroup = workspaceGroups.find(item => item.id === groupEditor?.id);
  const focusedTabId = focusedGroup(space.dock).activeId;
  const selected = space.nodes.find(n => n.id === mapGraph(space, focusedTabId).selectedId);
  const sessions = state.sessions.filter(s => s.workspaceId === space.id);
  const unread = state.notices.filter(n => !n.read).length;
  const change: ChangeState = useCallback(update => dispatch({type:'change',update}), []);
  const edit=(workspaceId:string,update:(value:WorkbenchState)=>WorkbenchState,key?:string)=>dispatch({type:'edit',workspaceId,update,key,at:Date.now()});
  const persistence = useWorkbenchPersistence(state, change, loaded.error);
  const workspaceDrag = useWorkspaceDrag(persistence.readOnly, (id, target) =>
    change(s => moveWorkspaceToGroup(s, id, target.groupId, target.neighbor)));
  const knowledge=useKnowledgeCollection(state,persistence.ready&&!persistence.readOnly&&persistence.saved);
  const nativeBrowsers = useNativeBrowserHost(state, change, persistence.ready);
  const agents = useNativeAgents(state, change, persistence.ready,!knowledgeOpen,!persistence.readOnly);
  const agentRuntime=useMemo(()=>agents?{...agents,readOnly:persistence.readOnly,backends:persistence.readOnly?[]:agents.backends}:null,[agents,persistence.readOnly]);
  const prefetchModels = agents?.prefetchModelOptions;
  const localBackends = agents?.backends;
  const canPrefetchModels = persistence.ready && !persistence.readOnly && !knowledgeOpen;
  useEffect(() => {
    if (!canPrefetchModels || !prefetchModels) return;
    const scope = new AbortController();
    for (const backend of localBackends ?? []) {
      if (backend.available && Object.hasOwn(agentNames, backend.id)) void prefetchModels(backend.id, space.id, space.cwd, scope.signal);
    }
    return () => scope.abort();
  }, [canPrefetchModels, prefetchModels, localBackends, space.id, space.cwd]);
  const focusedTab = space.dock.tabs.find(tab => tab.id === focusedTabId);
  const focusedSession = focusedTab?.kind === 'session' ? sessions.find(session => session.id === focusedTab.sessionId) : undefined;
  const focusedSessionBackend = focusedSession?.integrationId;
  const focusedSessionCwd = focusedSession?.cwd;
  useEffect(() => {
    if (!canPrefetchModels || !prefetchModels || !focusedSessionBackend || !focusedSessionCwd ||
      (space.cwd && modelCatalogDirectory(focusedSessionCwd) === modelCatalogDirectory(space.cwd))) return;
    if (localBackends?.some(backend => backend.id === focusedSessionBackend && backend.available)) {
      const scope = new AbortController();
      void prefetchModels(focusedSessionBackend, space.id, focusedSessionCwd, scope.signal);
      return () => scope.abort();
    }
  }, [canPrefetchModels, prefetchModels, localBackends, space.id, space.cwd, focusedSessionBackend, focusedSessionCwd]);
  const background = useNativeBackground(state, change, persistence.ready, openNotice);
  const mapError = useMapOperations(state, change, persistence.ready);
  const updateSpace = (update: (space: Workspace) => Workspace) => change(s => updateWorkspace(s, space.id, update));
  async function removeContent() {
    if (!deletion || !persistence.ready || persistence.readOnly) throw Error('工作区尚未就绪，请重试读取后再删除。');
    const target = deletion;
    const ids = current.current.sessions.filter(session => target.kind === 'workspace' ? session.workspaceId === target.id : session.id === target.id).map(session => session.id);
    assertSessionsIdle(current.current, ids);
    if (agents) await agents.remove(ids, target.kind === 'workspace' ? target.id : undefined);
    change(s => target.kind === 'workspace' ? deleteWorkspace(s, target.id) : deleteSessions(s, ids));
    setDialog(null); setNewNodeId(null); setInbox(false);
  }
  async function renameManagedSession(id: string, title: string) {
    if (!persistence.ready || persistence.readOnly) throw Error('工作区尚未就绪，请稍后重试。');
    const session = current.current.sessions.find(session => session.id === id);
    if (!session) throw Error('会话不存在。');
    if (session.integrationId !== 'demo-agent') {
      if (!agents) throw Error('请在 Windows 版重命名本机会话。');
      await agents.rename(id, title);
    }
    change(s => renameSession(s, id, title));
  }
  useEffect(() => {
    if (!persistence.ready) return;
    const tick = () => change(s => reconcileSessions(s, Date.now()));
    tick(); const timer = setInterval(tick, 500); return () => clearInterval(timer);
  }, [change, persistence.ready]);
  function switchSpace(id: string) {setKnowledgeOpen(false);change(s => ({...expandWorkspaceGroup(s, id), activeId: id})); setDialog(null); setNewNodeId(null); setInbox(false);}
  function showWorkspaceCreation(groupId = '') {
    setWorkspaceCreationGroup(groupId);
    setKnowledgeOpen(false);
    setDialog('workspace');
  }
  function beginWorkspaceRename(workspace: Workspace) {
    change(s => expandWorkspaceGroup(s, workspace.id));
    setRenamingWorkspace(workspace);
  }
  function openAgent(id: string) {
    setKnowledgeOpen(false);
    change(s => {const next = openSession(s, id); return updateWorkspace(expandWorkspaceGroup(next, next.activeId), next.activeId, w => ({...w, sessionPanelOpen: false}));});
    setInbox(false); setDialog(null);
  }
  function openReport(workspaceId: string, url: string, file: string) {
    setKnowledgeOpen(false);
    change(s => ({...updateWorkspace(expandWorkspaceGroup(s, workspaceId), workspaceId, w => ({...w, dock: openDockTab(w.dock, {id: `report:${url}:${file}`, kind: 'report', title: 'PR 检视报告', url, file})})), activeId: workspaceId}));
    setInbox(false); setDialog(null);
  }
  function openNotice(notice: Notice) {
    if (!current.current.spaces.some(w => w.id === notice.workspaceId)) return;
    change(s => ({...s, notices: s.notices.map(n => n.id === notice.id ? {...n, read: true} : n)}));
    const target = notice.target || (notice.sessionId ? {kind: 'session' as const, sessionId: notice.sessionId} : {kind: 'workspace' as const});
    if (target.kind === 'report') openReport(notice.workspaceId, target.url, target.file);
    else if (target.kind === 'session') openAgent(target.sessionId);
    else switchSpace(notice.workspaceId);
  }
  function startSession(agentId: AgentSession['agentId'], nodeId: string | null = null, groupId?: string) {
    if(persistence.readOnly)return;
    const id = crypto.randomUUID(); const at = Date.now();
    const title = createSession(current.current, space.id, nodeId, id, at, agentId).sessions.find(s => s.id === id)!.title;
    change(s => {const target = groupId ? updateWorkspace(s, space.id, w => ({...w, dock: {...w.dock, activeGroupId: groupId}})) : s; const next = updateWorkspace(createSession(target, space.id, nodeId, id, at, agentId, title), space.id, w => ({...w, sessionPanelOpen: false})); return agents ? {...next, sessions: next.sessions.map(session => session.id === id ? {...session, integrationId: agentId || 'codex', cwd: space.cwd} : session)} : next;});
    if (agents) agents.create({id, workspaceId: space.id, nodeId, backend: agentId || 'codex', title, cwd: space.cwd});
    setInbox(false);
  }
  function changeGraph(graph: GraphState, tabId = focusedTabId) {if (graph.selectedId !== newNodeId) setNewNodeId(null); updateSpace(s => updateMapGraph(s, graph, tabId));}
  function openNode(id: string) {
    setKnowledgeOpen(false);
    setNewNodeId(null);
    change(s=>{const target=s.spaces.find(w=>w.id===space.id);if(!target?.nodes.some(node=>node.id===id))return s;return updateWorkspace(selectWorkspaceTab(s,space.id),space.id,w=>({...w,graph:{...w.graph,selectedId:id,focusId:null,collapsed:[],camera:null}}));});
    setDialog(null);
  }
  function selectTab(id: string) {
    const tab = space.dock.tabs.find(t => t.id === id);
    if (tab?.kind === 'session') openAgent(tab.sessionId);
    else {change(s => updateWorkspace(s, space.id, w => ({...w, dock: selectDockTab(w.dock, id)}))); setInbox(false); setDialog(null);}
  }
  function closeTab(id: string) {
    const tab = space.dock.tabs.find(t => t.id === id);
    if (tab?.kind === 'session') change(s => closeSessionTab(s, space.id, tab.sessionId));
    else updateSpace(w => ({...w, dock: closeDockTab(w.dock, id)}));
  }
  function openBusiness(page: BusinessPage, groupId?: string) {setKnowledgeOpen(false);updateSpace(w=>({...w,dock:openDockTab(w.dock,{id:!groupId?w.dock.tabs.find(t=>t.kind==='business'&&t.page===page)?.id||crypto.randomUUID():crypto.randomUUID(),kind:'business',page,title:businessComponents.find(item=>item.id===page)!.title},groupId)}));}
  function createTab(kind: 'map' | 'browser' | 'review' | 'events' | NonNullable<AgentSession['agentId']> | `business:${BusinessPage}` | `integration:${string}`, groupId: string) {
    if(kind==='map'){updateSpace(w=>openMapTab(w,groupId,crypto.randomUUID()));return;}
    if(kind==='events'){updateSpace(w=>({...w,dock:openDockTab(w.dock,{id:crypto.randomUUID(),kind:'events',title:'工作区事件'},groupId)}));return;}
    if(kind.startsWith('integration:')){const [id,surfaceId]=kind.slice(12).split(':');const integration=state.externalIntegrations?.find(i=>i.id===id);const surface=integration?.surfaces.find(s=>s.id===surfaceId);if(surface)updateSpace(w=>({...w,dock:openDockTab(w.dock,{id:crypto.randomUUID(),kind:'browser',title:surface.title||integration!.name,url:surface.entry},groupId)}));return;}
    if (kind.startsWith('business:')) {const page=kind.slice(9);if(isBusinessPage(page))openBusiness(page,groupId);return;}
    if (kind !== 'browser' && kind !== 'review') {startSession(kind as NonNullable<AgentSession['agentId']>, null, groupId); return;}
    const id = crypto.randomUUID();
    const tab: DockTab = kind === 'browser' ? {id, kind, title: '新标签页', url: ''} : {id, kind, title: '文件审查', files: []};
    updateSpace(w => ({...w, dock: openDockTab(w.dock, tab, groupId)}));
  }
  function updateTab(tab: DockTab) {updateSpace(w => ({...w, dock: {...w.dock, tabs: w.dock.tabs.map(t => t.id === tab.id ? tab : t)}}));}
  function openLocalService(service: LocalService) {
    updateSpace(workspace => {
      const existing = workspace.dock.tabs.find(tab => tab.kind === 'browser' && tab.url.startsWith(service.url));
      const dock = existing ? selectDockTab(workspace.dock, existing.id) : openDockTab(workspace.dock, {
        id: crypto.randomUUID(), kind: 'browser', title: service.title, url: service.url,
      });
      return {...workspace, dock};
    });
    setDialog(null);
    setInbox(false);
  }
  function openMaterial(material: NodeMaterial | SessionMaterial, selected: MindNode) {
    const parsed=parseMaterialTarget(material.target);
    if ('sessionId' in material) {
      if (parsed.kind === 'web') {
        const tab: DockTab = {id: crypto.randomUUID(), kind: 'browser', title: material.title, url: parsed.target};
        updateSpace(workspace => ({...workspace, dock: openDockTab(workspace.dock, tab)}));
        return;
      }
      if (!agents) throw new Error('请在 DraftWay 桌面版打开本地文件。');
      if (isHtmlReport(parsed.target)) {
        change(state => openLocalReport(state, space.id, parsed.target));
        return;
      }
      return invoke('open_session_path', {id: material.sessionId, path: parsed.target});
    }
    const tab: DockTab=parsed.kind==='web' ? {id:crypto.randomUUID(),kind:'browser',title:material.title || parsed.title,url:parsed.target} : {id:`material:${selected.id}:${material.id}`,kind:'material',title:material.title || parsed.title,nodeId:selected.id,materialId:material.id};
    const open = () => updateSpace(workspace => workspace.nodes.some(node => node.id === selected.id && node.materials?.some(item => item.id === material.id))
      ? {...workspace, dock: openDockTab(workspace.dock, tab)} : workspace);
    if (tab.kind === 'material' && agents) {
      void persistence.flush().then(open).catch(error => dispatch({type: 'error', message: String(error)}));
    } else {
      open();
    }
  }

  useEffect(() => {recentSwitch.current = null;}, [space.id]);
  function updateNodeMaterials(nodeId: string, update: (materials: NodeMaterial[]) => NodeMaterial[]) {
    if (persistence.readOnly) return;
    edit(space.id, s => updateWorkspace(s, space.id, workspace => {
      const node = workspace.nodes.find(item => item.id === nodeId);
      if (!node) return workspace;
      const previous = node.materials ?? [];
      const materials = update(previous);
      if (previous === materials) return workspace;
      const retained = new Set(materials.map(material => material.id));
      let dock = workspace.dock;
      for (const tab of workspace.dock.tabs) {
        if (tab.kind === 'material' && tab.nodeId === node.id && !retained.has(tab.materialId)) {
          dock = closeDockTab(dock, tab.id);
        }
      }
      return {...workspace, dock, nodes: workspace.nodes.map(item => item.id === node.id ? {...item, materials} : item)};
    }));
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {event.preventDefault(); setDialog(d => d === 'search' ? null : 'search'); return;}
      if (dialog) return;
      if (event.altKey && !event.ctrlKey && /^[1-9]$/.test(event.key)) {const next=current.current.spaces[Number(event.key)-1];if(next){event.preventDefault();switchSpace(next.id);}return;}
      if(knowledgeOpen)return;
      if(event.ctrlKey&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='t'){event.preventDefault();createTab('browser',space.dock.activeGroupId);return;}
      if(event.ctrlKey&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='w'){event.preventDefault();closeTab(focusedGroup(space.dock).activeId);return;}
      if((event.ctrlKey&&!event.altKey&&event.key.toLowerCase()==='l')||event.key==='F6'){const tab=space.dock.tabs.find(t=>t.id===focusedGroup(space.dock).activeId);if(tab?.kind==='browser'){event.preventDefault();const input=document.querySelector<HTMLInputElement>(`[data-browser-address="${CSS.escape(tab.id)}"]`);if(event.key==='F6'&&nativeBrowsers?.statuses[tab.id]?.ready)nativeBrowsers.action(tab.id,'focus');else{input?.focus();input?.select();}}return;}
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault();
        let cycle = recentSwitch.current;
        if (!cycle || cycle.workspaceId !== space.id) {
          const activeId = focusedGroup(space.dock).activeId;
          const ids = [...new Set([activeId, ...[...space.dock.recent].reverse(), ...space.dock.tabs.map(t => t.id)])].filter(Boolean);
          cycle = {workspaceId: space.id, ids, index: activeId ? 0 : -1};
          recentSwitch.current = cycle;
        }
        const direction = event.shiftKey ? -1 : 1;
        cycle.index = cycle.index < 0
          ? (event.shiftKey ? cycle.ids.length - 1 : 0)
          : (cycle.index + direction + cycle.ids.length) % cycle.ids.length;
        selectTab(cycle.ids[cycle.index]); return;
      }
      if (event.ctrlKey && event.shiftKey && ['[', ']', '{', '}'].includes(event.key)) {
        event.preventDefault(); const group = focusedGroup(space.dock); const ids = group.tabs; if (!ids.length) return; selectTab(ids[(ids.indexOf(group.activeId) + ([']','}'].includes(event.key) ? 1 : -1) + ids.length) % ids.length]); return;
      }
      if (event.key === 'Escape') {
        if (inbox) setInbox(false);
        else if (space.sessionPanelOpen) updateSpace(w => ({...w, sessionPanelOpen: false}));
        else changeGraph({...mapGraph(space, focusedTabId), selectedId: null});
      }
    };
    const release = (event: KeyboardEvent) => {if (event.key === 'Control') recentSwitch.current = null;};
    document.addEventListener('keydown', listener); document.addEventListener('keyup', release); return () => {document.removeEventListener('keydown', listener); document.removeEventListener('keyup', release);};
  }, [dialog, inbox, space, knowledgeOpen]);
  const nodeLinks=new Map<string,Set<string>>();const knownSessions=new Set(sessions.map(s=>s.id));
  for(const session of sessions)for(const id of sessionNodeIds(session)){const ids=nodeLinks.get(id)||new Set<string>();ids.add(session.id);nodeLinks.set(id,ids);}
  for(const node of space.nodes)for(const update of node.updates||[])if(update.sessionId&&knownSessions.has(update.sessionId)){const ids=nodeLinks.get(node.id)||new Set<string>();ids.add(update.sessionId);nodeLinks.set(node.id,ids);}
  const sessionCounts=Object.fromEntries([...nodeLinks].map(([id,sessions])=>[id,sessions.size]));
  function mapView(tab: Extract<DockTab, {kind: 'map'}>) {
    const graph = mapGraph(space, tab.id);
    const selected = space.nodes.find(n => n.id === graph.selectedId && n.id !== newNodeId);
    const nodeSessions = selected ? sessions.filter(s => sessionNodeIds(s).includes(selected.id) || selected.updates?.some(u=>u.sessionId===s.id)) : [];
    const updates = (selected?.updates ?? []).filter(update => update.id !== 'migration-task-state').reverse();
    const changeView = (graph: GraphState) => changeGraph(graph, tab.id);
    return <div className="workspace-map-scene">
      <main className="workspace-map" aria-label="工作区"><GraphView key={`${space.id}-${tab.id}`} space={{...space, graph}} onChange={changeView}
        onBackgroundChange={persistence.readOnly ? undefined : background => updateSpace(w => updateMapGraph(w, {...mapGraph(w, tab.id), background}, tab.id))} editing={{
        canUndo:!!editor.past[space.id]?.length,canRedo:!!editor.future[space.id]?.length,error:editor.error,
        undo:()=>{setNewNodeId(null);dispatch({type:'undo',workspaceId:space.id});},redo:()=>{setNewNodeId(null);dispatch({type:'redo',workspaceId:space.id});},
        sibling:nodeId=>{const id=crypto.randomUUID();edit(space.id,s=>createMapSibling(s,space.id,nodeId,id,tab.id));setNewNodeId(id);},
        remove:nodeId=>{setNewNodeId(null);edit(space.id,s=>deleteMapBranch(s,space.id,nodeId));},
        move:(nodeId,targetId,position)=>edit(space.id,s=>moveMapBranch(s,space.id,nodeId,targetId,position,tab.id)),
        copy:(nodeId,cut)=>{const owner=current.current.spaces.find(w=>w.id===space.id)!;const ids=(typeof nodeId==='string'?[nodeId]:nodeId).filter(id=>owner.nodes.some(n=>n.id===id&&(!cut||n.parentId)));if(!ids.length)return null;const copied=copyMapBranch(owner,ids);nodeClipboard.current=copied;if(cut){setNewNodeId(null);edit(space.id,s=>deleteMapBranch(s,space.id,ids));}return copied;},
        paste:(nodeId,text,token)=>{try{const internal=text===undefined||token===nodeClipboard.current?.token?nodeClipboard.current:null;const nodes=clipboardNodes(text??nodeClipboard.current?.text??'',internal);const ids=nodes.map(()=>crypto.randomUUID());edit(space.id,s=>pasteMapBranch(s,space.id,nodeId,nodes,ids,tab.id));return ids[0]||null;}catch(error){dispatch({type:'error',message:String(error)});return null;}},
        failure:message=>dispatch({type:'error',message})
      }} onInspect={id=>{setNewNodeId(null);changeView({...graph,selectedId:id});}} onRename={(id,title)=>{edit(space.id,s=>renameMapNode(s,space.id,id,title));if(id===newNodeId){setNewNodeId(null);changeView({...graph,selectedId:null});}}} autoEditId={newNodeId === graph.selectedId ? newNodeId : null} onAdd={parentId => {if (space.nodes.length >= 250) return; const id = crypto.randomUUID(); edit(space.id,s => createMapNode(s, space.id, parentId, id, tab.id)); setNewNodeId(id);}} sessionCounts={sessionCounts}/></main>
      {selected && <NodeInspector key={`${space.id}-${selected.id}`} node={selected} onDelete={()=>{setNewNodeId(null);edit(space.id,s=>deleteMapBranch(s,space.id,selected.id));}} onEditBody={value=>edit(space.id,s=>editNodeBody(s,space.id,selected.id,value),"body:"+selected.id)} onClose={() => changeView({...graph, selectedId: null})} onFocus={() => changeView({...graph, focusId: selected.id, selectedId: null, collapsed: [], camera: null})}>
        <NodeOverview space={space} node={selected} onDue={due=>edit(space.id,s=>updateWorkspace(s,space.id,w=>({...w,nodes:w.nodes.map(n=>n.id===selected.id?{...n,due}:n)})))} onOpen={id=>changeView({...graph,selectedId:id,focusId:null,camera:null})} onAdd={()=>{const id=crypto.randomUUID();edit(space.id,s=>{const next=addSubtask(s,space.id,selected.id,id);return next===s?s:updateWorkspace(next,space.id,w=>updateMapGraph(w,{...mapGraph(w,tab.id),selectedId:id,focusId:null,collapsed:graph.collapsed.filter(value=>value!==selected.id),camera:null},tab.id));});setNewNodeId(id);}}/>
          <NodeMaterials node={selected} workspaceId={space.id} cwd={space.cwd} sessions={nodeSessions} readOnly={persistence.readOnly}
            onChange={update => updateNodeMaterials(selected.id, update)} onOpen={material => openMaterial(material, selected)}/>
          <section className="node-detail-section">
            <div className="detail-section-heading">
              <h3>关联会话{nodeSessions.length > 0 && <span className="detail-count">{nodeSessions.length}</span>}</h3>
              <BackendPicker text="新建会话" label={`在${selected.title}中新建会话`} onChoose={agent => startSession(agent, selected.id)}
                onOpen={() => {setInbox(false); updateSpace(w => ({...w, sessionPanelOpen: false}));}} onLink={() => setDialog('link')}/>
            </div>
            {nodeSessions.map(session => <SessionRow key={session.id} state={state} session={session} onOpen={() => openAgent(session.id)}/>)}
          </section>
          <section className="node-detail-section">
            <div className="detail-section-heading"><h3>更新记录{updates.length > 0 && <span className="detail-count">{updates.length}</span>}</h3></div>
            {updates.length > 0 && <div className="node-timeline">{updates.map(update => {
              const source = sessions.find(s => s.id === update.sessionId);
              const time = update.at === 0 && update.id.startsWith('migration-') ? '旧数据迁移' : new Date(update.at).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
              const author = source ? `${agentNames[source.agentId || 'codex']}${source.integrationId === 'demo-agent' ? '（模拟）' : ''}` : '我';
              return <div key={update.id}>
                <strong>{update.text}</strong><small>{time} · {author}</small>
                {source && <button className="text-button" onClick={() => openAgent(source.id)}>查看来源会话<ChevronRight size={12}/></button>}
              </div>;
            })}</div>}
            <ProgressForm onSubmit={text => {
              const update = {id: crypto.randomUUID(), at: Date.now(), text};
              edit(space.id, s => updateWorkspace(s, space.id, w => ({...w, nodes: w.nodes.map(n => n.id === selected.id ? {...n, updates: [...(n.updates ?? []), update]} : n)})));
            }}/>
          </section>
      </NodeInspector>}
    </div>;
  }
  if (!persistence.ready) return <div className="workbench-loading" data-tauri-drag-region>正在恢复工作区…<DesktopWindowControls/></div>;
  const canCreateWorkspace = !persistence.readOnly && state.spaces.length < 20;
  const createMenuOpen = managementMenu?.kind === 'create';
  const workspaceTitle = knowledgeOpen ? '个人知识库' : space.name;
  const inlineTabs = !knowledgeOpen && space.dock.root.kind === 'group';
  const windowTitle = <h1 title={workspaceTitle} onDoubleClick={() => {if (!knowledgeOpen && !persistence.readOnly) beginWorkspaceRename(space);}}>{workspaceTitle}</h1>;
  const windowActions = <div className="workspace-titlebar-actions">
    <div className="workspace-actions">
      {!knowledgeOpen && <>
        <button className={`session-panel-toggle ${space.sessionPanelOpen ? 'active' : ''}`} aria-expanded={space.sessionPanelOpen}
          aria-controls="workspace-session-panel" onClick={() => updateSpace(w => ({...w, sessionPanelOpen: !w.sessionPanelOpen}))}>
          会话记录（{sessions.length}）<ChevronDown size={13}/>{sessions.some(s => s.unread) && <i className="unread-dot"/>}
        </button>
        {agents && <button className="text-button" aria-label="本地服务" title="本地服务" onClick={() => setDialog('localServices')}><Globe size={15}/></button>}
        {agents && <button className="text-button" aria-label="协作室" title="协作室" onClick={() => setDialog('room')}><MessagesSquare size={15}/></button>}
      </>}
      <button className="icon-button bell-button" aria-label={`通知${unread ? `，${unread}条未读` : ''}`} title="通知" aria-expanded={inbox}
        onClick={() => setInbox(v => !v)}><Bell size={15}/>{!!unread && <span>{unread}</span>}</button>
      {!knowledgeOpen && <button className="text-button" aria-label="自定工作区" title="自定工作区"
        onClick={() => setDialog('customize')}><Settings2 size={15}/></button>}
    </div>
    <DesktopWindowControls/>
  </div>;
  const groupsByWorkspace = new Set(workspaceGroups.flatMap(group => group.workspaceIds));
  const ungroupedWorkspaces = state.spaces.filter(item => !groupsByWorkspace.has(item.id));
  const menuGroupIndex = managementMenu?.kind === 'group' ? workspaceGroups.findIndex(group => group.id === managementMenu.id) : -1;
  const renderWorkspace = (item: Workspace) => {
    const index = state.spaces.indexOf(item);
    const count = state.notices.filter(n => n.workspaceId === item.id && !n.read).length;
    const running = state.runs.some(r => r.state === 'running' && state.sessions.some(s => s.id === r.sessionId && s.workspaceId === item.id)) || !!(item.review && background.reviews[item.id]?.runningCount);
    return <WorkspaceEntry key={item.id} space={item} active={!knowledgeOpen && item.id === space.id} editing={renamingWorkspace?.id === item.id}
      dragging={workspaceDrag.dragging === item.id} dropEdge={workspaceDrag.destination?.neighbor?.id === item.id ? workspaceDrag.destination.neighbor.position : undefined}
      disabled={persistence.readOnly} title={item.name + (index < 9 ? ' · Alt+' + (index + 1) : '')} onOpen={() => switchSpace(item.id)}
      onRename={() => beginWorkspaceRename(item)} onSave={name => change(s => updateWorkspace(s, item.id, w => ({...w, name})))} onFinish={() => setRenamingWorkspace(null)}>
      {count ? <span className="count-badge dark">{count}</span> : running ? <span className="running-dot" aria-label="有任务运行中"/> : null}
    </WorkspaceEntry>;
  };
  const managementActions: ManagementAction[] = !managementMenu ? [] : managementMenu.kind === 'create' ? [
    {label: '新建工作区', icon: LayoutGrid, disabled: !canCreateWorkspace, run: () => showWorkspaceCreation()},
    {label: '新建分组', icon: FolderPlus, disabled: persistence.readOnly, run: () => setGroupEditor({})},
  ] : managementMenu.kind === 'workspace' ? [
    {label: '打开工作区', icon: FolderOpen, run: () => switchSpace(managementMenu.id)},
    {label: '重命名工作区', icon: Pencil, shortcut: 'F2', disabled: !persistence.ready || persistence.readOnly, run: () => setRenamingWorkspace(state.spaces.find(w => w.id === managementMenu.id) || null)},
    {label: '自定工作区', icon: Settings2, run: () => {switchSpace(managementMenu.id); setDialog('customize');}},
    ...(workspaceGroups.length ? [{label: '移动到分组', icon: FolderInput, disabled: persistence.readOnly, run: () => setMovingWorkspaceId(managementMenu.id)}] : []),
    {label: '删除工作区', icon: Trash2, separatorBefore: true, danger: true, disabled: persistence.readOnly, run: () => setDeletion({kind: 'workspace', id: managementMenu.id, name: managementMenu.name})},
  ] : managementMenu.kind === 'group' ? [
    {label: '在组内新建工作区', icon: Plus, disabled: !canCreateWorkspace, run: () => showWorkspaceCreation(managementMenu.id)},
    {label: '重命名分组', icon: Pencil, shortcut: 'F2', disabled: persistence.readOnly, run: () => setGroupEditor({id: managementMenu.id})},
    {label: '上移分组', icon: ArrowUp, disabled: persistence.readOnly || menuGroupIndex < 1,
      run: () => change(s => moveWorkspaceGroup(s, managementMenu.id, -1))},
    {label: '下移分组', icon: ArrowDown, disabled: persistence.readOnly || menuGroupIndex < 0 || menuGroupIndex === workspaceGroups.length - 1,
      run: () => change(s => moveWorkspaceGroup(s, managementMenu.id, 1))},
    {label: '解散分组', icon: FolderOpen, separatorBefore: true, disabled: persistence.readOnly,
      run: () => change(s => dissolveWorkspaceGroup(s, managementMenu.id))},
  ] : [
    {label: '打开会话', icon: MessageSquare, run: () => openAgent(managementMenu.id)},
    {label: '重命名会话', icon: Pencil, disabled: !persistence.ready || persistence.readOnly, run: () => setRenamingSession(state.sessions.find(s => s.id === managementMenu.id) || null)},
    {label: '关闭页签', icon: X, disabled: !state.spaces.some(w => w.dock.tabs.some(t => t.kind === 'session' && t.sessionId === managementMenu.id)), run: () => {const session = state.sessions.find(s => s.id === managementMenu.id); if (session) change(s => closeSessionTab(s, session.workspaceId, session.id));}},
    {label: '删除会话', icon: Trash2, separatorBefore: true, danger: true, disabled: !persistence.ready || persistence.readOnly, run: () => setDeletion({kind: 'session', id: managementMenu.id, name: managementMenu.name})},
  ];
  return <AgentRuntimeContext.Provider value={agentRuntime}><div className="workbench-shell map-first-shell" onContextMenu={event => {
    if ((event.target as Element).closest('input, textarea, [contenteditable=true]')) return;
    const element = (event.target as Element).closest<HTMLElement>('[data-workspace-id], [data-workspace-group-id], [data-session-id], [data-dock-tab-id]');
    if (!element) return;
    const workspace = state.spaces.find(w => w.id === element.dataset.workspaceId);
    const group = workspaceGroups.find(item => item.id === element.dataset.workspaceGroupId);
    const tab = space.dock.tabs.find(t => t.id === element.dataset.dockTabId);
    const session = state.sessions.find(s => s.id === (element.dataset.sessionId || (tab?.kind === 'session' ? tab.sessionId : undefined)));
    const target = workspace || group || session;
    if (!target) return;
    event.preventDefault();
    const box = element.getBoundingClientRect();
    setManagementMenu({kind: workspace ? 'workspace' : group ? 'group' : 'session', id: target.id,
      name: workspace?.name ?? group?.name ?? session!.title, x: event.clientX || box.left, y: event.clientY || box.bottom,
      keyboard: !event.clientX && !event.clientY});
  }}>
    <div className="workspace-frame">
    <aside className="shell-sidebar" aria-label="主导航">
      <div className="sidebar-brand" data-tauri-drag-region><Star size={16}/><span>Draftway</span></div>
      <nav className="global-navigation">
        <div className="sidebar-search-row">
          <button type="button" className="sidebar-search" onClick={() => setDialog('search')}><Search size={16}/>搜索<kbd>Ctrl K</kbd></button>
          <button type="button" className="icon-button sidebar-create" id="sidebar-create-button" aria-label="新建" title="新建"
            aria-haspopup="menu" aria-expanded={createMenuOpen} disabled={persistence.readOnly} onClick={event => {
              const trigger = event.currentTarget;
              const box = trigger.getBoundingClientRect();
              setManagementMenu(createMenuOpen ? null : {kind: 'create', trigger, x: box.left, y: box.bottom + 6, keyboard: event.detail === 0});
            }}><Plus size={18}/></button>
        </div>
        <button className={knowledgeOpen?'active':''} aria-current={knowledgeOpen?'page':undefined} onClick={()=>{setKnowledgeVisited(true);setKnowledgeOpen(true);setDialog(null);setInbox(false);}}><BookOpen size={17}/>个人知识库</button>
      </nav>
      <div className="sidebar-label">工作区</div>
      <nav className="workspace-list" aria-label="工作区" {...workspaceDrag.handlers}>
        {workspaceGroups.map(group => <WorkspaceGroupEntry key={group.id} group={group} active={!knowledgeOpen && group.workspaceIds.includes(space.id)}
          dropping={workspaceDrag.destination?.groupId === group.id && !workspaceDrag.destination.neighbor}
          canRename={!persistence.readOnly}
          onToggle={() => change(s => updateWorkspaceGroup(s, group.id, item => ({...item, collapsed: !item.collapsed})))}
          onRename={() => setGroupEditor({id: group.id})}
          onMenu={event => {
            const box = event.currentTarget.getBoundingClientRect();
            setManagementMenu({kind: 'group', id: group.id, name: group.name, x: box.right, y: box.bottom, keyboard: event.detail === 0});
          }}>
          {group.workspaceIds.map(id => state.spaces.find(item => item.id === id)).filter(item => item !== undefined).map(renderWorkspace)}
        </WorkspaceGroupEntry>)}
        {ungroupedWorkspaces.map(renderWorkspace)}
        {workspaceDrag.dragging && groupsByWorkspace.has(workspaceDrag.dragging) &&
          <div className="sidebar-label workspace-top-level-drop" data-workspace-drop-ungrouped
            data-workspace-drop-target={workspaceDrag.destination?.groupId === '' && !workspaceDrag.destination.neighbor || undefined}>移到顶层</div>}
      </nav>
      <div className="sidebar-bottom">
        <span><span className="profile-avatar">我</span><span>个人空间</span></span>
        <div className="sidebar-utilities">
          <button className="icon-button" aria-label="接入与设置" title="接入与设置" onClick={() => setDialog('settings')}><Settings2 size={15}/></button>
          <button className="icon-button" aria-label="插件" title="插件" onClick={()=>setDialog('plugins')}><Puzzle size={15}/></button>
          <button className="icon-button" aria-label="个人工作台" title="个人工作台" onClick={()=>openBusiness('overview')}><LayoutGrid size={14}/></button>
        </div>
      </div>
    </aside>
    <div className="shell-body">
      {!inlineTabs && <header className="workspace-heading dock-workspace-heading" data-tauri-drag-region>
        <div className="workspace-title-row" data-tauri-drag-region>{windowTitle}{windowActions}</div>
      </header>}
    <div className={`workspace-body workspace-map-body dock-workspace-body${inlineTabs ? ' with-inline-tabs' : ''}`}>
      <div className="workspace-content-host" hidden={knowledgeOpen}><DockLayout key={space.id} state={state} space={space}
        windowChrome={inlineTabs ? {title: windowTitle, actions: windowActions} : undefined}
        onChange={update => updateSpace(w => ({...w, dock: update(w.dock)}))} onSelect={selectTab} onClose={closeTab} onCreate={createTab} render={(tab, active, visible) => {
        if (tab.kind === 'map') return mapView(tab);
        if (tab.kind === 'events') return <TasksView space={space} onOpen={openNode}/>;
        if (tab.kind === 'browser') return <BrowserView tab={tab} active={active&&!knowledgeOpen} onChange={updateTab} native={nativeBrowsers}/>;
        if (tab.kind === 'review') return <ReviewView workspaceId={space.id} tab={tab} onChange={updateTab}/>;
        if (tab.kind === 'material') return <MaterialView workspaceId={space.id} tab={tab}/>;
        if (tab.kind === 'business') return <BusinessView workspaceId={space.id} tab={tab} active={active&&!knowledgeOpen} onChange={updateTab} flush={persistence.flush} onWorkspace={()=>change(s=>selectWorkspaceTab(s,space.id))}/>;
        if (tab.kind === 'report') return <ReportView workspaceId={space.id} tab={tab} onDashboard={() => updateSpace(w => ({...w, dock: openDockTab(w.dock, {id: w.dock.tabs.find(t=>t.kind==='browser'&&t.url===tab.url)?.id||crypto.randomUUID(), kind: 'browser', title: 'PR 检视看板', url: tab.url})}))}/>;
        const session = state.sessions.find(s => s.id === tab.sessionId)!;
        return <SessionView state={state} session={session} active={active&&!knowledgeOpen} visible={visible&&!knowledgeOpen} change={change} onNode={id => {const nodeId = id || session.nodeId; if (nodeId) openNode(nodeId);}}/>;
      }}/></div>
      {knowledgeVisited&&<div className="personal-knowledge-host" hidden={!knowledgeOpen}>{knowledge.error&&<p className="knowledge-collection-error" role="alert">{knowledge.error}<button className="text-button" onClick={knowledge.retry}>重试入库</button></p>}<BusinessView workspaceId="personal" tab={personalKnowledgeTab} active={knowledgeOpen} onChange={tab=>{if(tab.kind==='business'&&tab.page!=='knowledge'){setKnowledgeVisited(false);openBusiness(tab.page);}}} flush={persistence.flush} onWorkspace={()=>setKnowledgeOpen(false)}/></div>}
      {!knowledgeOpen&&space.sessionPanelOpen && <aside className="workspace-session-panel" id="workspace-session-panel" aria-label="当前工作区会话"><header><h2>会话记录（{sessions.length}）</h2><button className="icon-button" aria-label="收起会话面板" onClick={() => updateSpace(w => ({...w, sessionPanelOpen: false}))}><X size={16}/></button></header><p className="quiet-note">{space.name} · 关闭页签后仍可在这里重新打开</p><SessionManagement key={space.id} state={state} workspaceId={space.id} disabled={!persistence.ready || persistence.readOnly} onOpen={openAgent} onRename={renameManagedSession} onDelete={session => setDeletion({kind: 'session', id: session.id, name: session.title})}/></aside>}

    </div>
    </div>
    </div>
    <footer className="shell-status"><span>{(persistence.error || mapError) ? <><CircleAlert size={12}/>{persistence.error || mapError}<button onClick={persistence.retry}>{persistence.readOnly ? '重试读取' : '重试保存'}</button></> : <><span className="saved-dot"/>{persistence.saved ? '已保存到本机' : '正在保存'}</>}</span><span>Alt + 1…9 切换工作区 · Ctrl + Tab 切换最近页签</span></footer>
    {inbox && <aside className="notification-panel" aria-label="通知中心"><header><h2>通知</h2><button className="text-button" onClick={() => change(s => ({...s, notices: s.notices.map(n => ({...n, read: true})), sessions: s.sessions.map(session => ({...session, unread: false}))}))}>全部已读</button><button className="icon-button" aria-label="关闭通知中心" onClick={() => setInbox(false)}><X size={16}/></button></header>{background.error && <p className="tool-error" role="alert">{background.error}</p>}{state.spaces.filter(w => w.review).map(w => {const status = background.reviews[w.id]; return <div className="review-status" key={w.id}><strong>{w.name}</strong><small>{!status ? agents ? '正在连接检视服务' : '请在 Windows 版跟踪状态' : !status.connected ? `连接中断 · ${status.error}` : status.error || `${status.runningCount} 个 PR 处理中${status.paused ? ' · 已暂停调度' : ''}`}</small>{status?.historyGap && <small>离线期间可能有遗漏，请查看原看板。</small>}{status?.reports.slice(0, 5).map(report => <button className="text-button" key={report.file} onClick={() => openReport(w.id, status.url, report.file)}>{report.prs.map(n => `#${n}`).join('、') || '检视报告'} · {report.state === 'running' ? '进行中' : report.state === 'succeeded' ? '已完成' : report.state === 'failed' ? '失败' : '状态待确认'}<ChevronRight size={12}/></button>)}</div>;})}{[...state.notices].reverse().map(n => <button key={n.id} className={`notice-row ${n.read ? '' : 'unread'}`} onClick={() => openNotice(n)}><Bell size={15}/><span><strong>{n.title}</strong><small>{n.body || state.sessions.find(s => s.id === n.sessionId)?.title || state.spaces.find(w => w.id === n.workspaceId)?.name}</small></span><ChevronRight size={14}/></button>)}{!state.notices.length && <Empty title="这里暂时很安静"/>}</aside>}
    {managementMenu && <ManagementMenu key={managementMenu.kind} x={managementMenu.x} y={managementMenu.y} keyboard={managementMenu.keyboard}
      trigger={createMenuOpen ? managementMenu.trigger : undefined} actions={managementActions} onClose={() => setManagementMenu(null)}/>}

    {renamingSession && <RenameSessionDialog session={renamingSession} onClose={() => setRenamingSession(null)} onSave={renameManagedSession}/>}
    {deletion && <DeleteDialog title={deletion.kind === 'workspace' ? '删除工作区' : '删除会话'} description={deletion.kind === 'workspace' ? `删除「${deletion.name}」的地图、布局，以及其中全部 ${state.sessions.filter(session => session.workspaceId === deletion.id).length} 个会话与执行记录。` : `删除「${deletion.name}」的消息、草稿、执行记录和会话产物。已保留到地图的内容继续保留。`} onClose={() => setDeletion(null)} onDelete={removeContent}/>}
    {groupEditor && (!groupEditor.id || editingGroup) && <WorkspaceGroupDialog group={editingGroup} groups={workspaceGroups}
      onClose={() => setGroupEditor(null)} onSave={name => {
        if (editingGroup) change(s => updateWorkspaceGroup(s, editingGroup.id, group => ({...group, name})));
        else {
          const group = {id: crypto.randomUUID(), name, workspaceIds: []};
          change(s => ({...s, workspaceGroups: [...(s.workspaceGroups ?? []), group]}));
        }
        setGroupEditor(null);
      }}/>}
    {movingWorkspace && <MoveWorkspaceDialog name={movingWorkspace.name} groups={workspaceGroups}
      currentGroup={workspaceGroupOf(state, movingWorkspace.id)?.id ?? ''} onClose={() => setMovingWorkspaceId(null)}
      onMove={groupId => {
        change(s => moveWorkspaceToGroup(s, movingWorkspace.id, groupId));
        setMovingWorkspaceId(null);
      }}/>}
    {dialog === 'workspace' && <WorkspaceDialog templates={state.templates} groups={workspaceGroups} initialGroup={workspaceCreationGroup}
      onClose={() => setDialog(null)} onCreate={(name, templateId, cwd, groupId) => {
      const template = state.templates?.find(item => item.id === templateId);
      const next = template ? fromTemplate(name, template) : createWorkspace(name, 'blank');
      change(s => s.spaces.length >= 20 ? s : moveWorkspaceToGroup({...s, activeId: next.id, spaces: [...s.spaces, {...next, cwd}]}, next.id, groupId));
      setDialog(null);
    }}/>}

    {dialog === 'plugins' && <PluginManagerDialog onClose={()=>setDialog(null)}/>}
    {dialog === 'localServices' && <LocalServices onOpen={openLocalService} onClose={() => setDialog(null)}/>}
    {dialog === 'room' && <RoomDialog onOpenSession={id => {setDialog(null); openAgent(id);}} onClose={() => setDialog(null)}/>}
    {dialog === 'settings' && <Dialog title="接入与设置" onClose={() => setDialog(null)}>
      <AppearancePicker value={appearance.choice} onChange={appearance.setChoice}/>
      <p className="muted">{agents ? '使用本机已安装的执行器。会话、来源标识和执行记录由 Draftway 保存。' : '浏览器模式使用模拟器；真实 Agent 请在 Windows 版中操作。'}</p>
      <div className="integration-list">{integrations.filter(i => ['codex', 'claude', 'pi'].includes(i.id)).map(i => <div key={i.id}><Terminal size={16}/><span><strong>{i.name}</strong><small>{i.description}</small></span><span className="small-tag">{agents?.backends.find(backend => backend.id === i.id)?.available ? '已发现' : '未发现'}</span></div>)}</div>
      <p className="quiet-note">地图、会话和更新记录保存在本机。Windows 版收起或切换工作区后继续执行；退出 Draftway 会停止本机执行器。</p>
    </Dialog>}
    {dialog === 'customize' && <CustomizeDialog space={space} onClose={() => setDialog(null)} onSave={(name, cwd, review, materialRoots) => {updateSpace(w => ({...w, name, cwd, review, materialRoots})); setDialog(null);}} onPlace={(title, body, kind) => {const node: MindNode = {id: crypto.randomUUID(), parentId: space.nodes.find(n => !n.parentId)!.id, side: 1, kind, title:boundedText(title,120), body, progress: 0, due: '', }; updateSpace(w => ({...w, nodes: [...w.nodes, node], graph: {...w.graph, selectedId: node.id, camera: null}})); change(s => selectWorkspaceTab(s, space.id)); setDialog(null);}}>
      <section className="workspace-delete-section"><button type="button" className="outline-button danger-text" disabled={!persistence.ready || persistence.readOnly} onClick={() => {setDialog(null); setDeletion({kind: 'workspace', id: space.id, name: space.name});}}><Trash2 size={15}/>删除工作区</button><p className="quiet-note">删除此工作区的地图、布局和全部会话。删除最后一个工作区后会创建空白工作区。</p></section>
      <CompositionSettings workspaceName={space.name} templates={state.templates||[]} integrations={state.externalIntegrations||[]} onTemplate={name=>change(s=>{const old=s.templates?.find(t=>t.name===name);const template=layoutTemplate(space,old?.id||crypto.randomUUID(),name);return{...s,templates:[...(s.templates||[]).filter(t=>t.id!==template.id),template]};})} onRemoveTemplate={id=>change(s=>({...s,templates:s.templates?.filter(t=>t.id!==id)}))} onIntegration={integration=>change(s=>({...s,externalIntegrations:[...(s.externalIntegrations||[]).filter(i=>i.id!==integration.id),integration]}))} onRemoveIntegration={id=>change(s=>({...s,externalIntegrations:s.externalIntegrations?.filter(i=>i.id!==id)}))}/>
    </CustomizeDialog>}
    {dialog === 'search' && <SearchDialog space={space} onClose={() => setDialog(null)} onOpen={openNode}/>}
    {dialog === 'link' && selected && <Dialog title="关联工作区会话" onClose={() => setDialog(null)}><p className="muted">从当前工作区选择已有会话，关联到「{selected.title}」。</p>{sessions.filter(s => !sessionNodeIds(s).includes(selected.id)).map(session => <SessionRow key={session.id} state={state} session={session} onOpen={() => {change(s => ({...s, sessions: s.sessions.map(item => item.id === session.id ? {...item, linkedNodeIds: [...(item.linkedNodeIds || []), selected.id]} : item)})); setDialog(null);}}/>)}{!sessions.some(s => !sessionNodeIds(s).includes(selected.id)) && <p className="quiet-note">暂无其他会话。可在节点的“＋”中选择后端创建。</p>}</Dialog>}

  </div></AgentRuntimeContext.Provider>;
}
function WorkspaceDialog({onClose, onCreate, templates = [], groups, initialGroup}: {
  onClose: () => void;
  onCreate: (name: string, templateId: string, cwd: string | undefined, groupId: string) => void;
  templates?: {id: string; name: string}[];
  groups: WorkspaceGroup[];
  initialGroup: string;
}) {
  const agents = useAgentRuntime();
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [groupId, setGroupId] = useState(initialGroup);
  const [cwd, setCwd] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const [directoryError, setDirectoryError] = useState('');

  async function chooseDirectory() {
    if (!agents) return;
    setChoosing(true);
    setDirectoryError('');
    try {
      const directory = await agents.chooseDirectory();
      if (directory) setCwd(directory);
    } catch {
      setDirectoryError('无法打开文件夹选择器，请重试。');
    } finally {
      setChoosing(false);
    }
  }

  return <Dialog title="新建工作区" onClose={onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!choosing && name.trim()) onCreate(name.trim(), templateId, cwd, groupId);
    }}>
      <label className="field">工作区名称
        <input autoFocus required maxLength={40} placeholder="填写工作区主题" value={name} onChange={event => setName(event.target.value)}/>
      </label>
      {!!groups.length && <WorkspaceGroupField groups={groups} value={groupId} onChange={setGroupId}/>}
      {agents && <section className="workspace-directory" aria-label="工作目录（可选）">
        <span>工作目录（可选）</span>
        <p>{cwd || '新会话使用默认工作区目录'}</p>
        <button type="button" className="outline-button" disabled={choosing} onClick={() => {void chooseDirectory();}}>选择文件夹</button>
        {cwd && <button type="button" className="text-button" disabled={choosing} onClick={() => setCwd(undefined)}>清除目录</button>}
        {directoryError && <p className="tool-error" role="alert">{directoryError}</p>}
      </section>}
      {!!templates.length && <label className="field">布局模板
        <select value={templateId} onChange={event => setTemplateId(event.target.value)}>
          <option value="">空白工作区</option>
          {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
      </label>}
      <footer><button className="primary-button" disabled={choosing || !name.trim()}>创建工作区</button></footer>
    </form>
  </Dialog>;
}

function ProgressForm({onSubmit}: {onSubmit: (text: string) => void}) {
  const [text, setText] = useState('');
  return <form className="node-progress-form" onSubmit={event => {event.preventDefault(); if (text.trim()) {onSubmit(text.trim()); setText('');}}}><input aria-label="更新记录内容" placeholder="记录一点进展" maxLength={1000} value={text} onChange={event => setText(event.target.value)}/><button className="icon-button" aria-label="追加更新记录" disabled={!text.trim()}><Plus size={15}/></button></form>;
}
function SearchDialog({space, onClose, onOpen}: {space: Workspace; onClose: () => void; onOpen: (id: string) => void}) {
  const [query, setQuery] = useState('');
  return <Dialog title="搜索当前工作区" onClose={onClose}><input className="search-field" autoFocus aria-label="搜索节点" placeholder="搜索节点与内容" value={query} onChange={event => setQuery(event.target.value)}/><div className="view-library">{space.nodes.filter(n => `${n.title} ${n.body}`.includes(query)).map(n => <button key={n.id} onClick={() => onOpen(n.id)}><NodeGlyph kind={n.kind} size={16}/><span>{n.title}</span><ChevronRight size={14}/></button>)}</div></Dialog>;
}
function CustomizeDialog({space, onClose, onSave, onPlace, children}: {space: Workspace; onClose: () => void; onSave: (name: string, cwd?: string, review?: Workspace['review'], materialRoots?: Workspace['materialRoots']) => void; onPlace: (title: string, body: string, kind: 'document' | 'artifact') => void; children?:ReactNode}) {
  const [name, setName] = useState(space.name);
  const agents = useAgentRuntime(); const [cwd, setCwd] = useState(space.cwd || '');
  const [reviewEnabled, setReviewEnabled] = useState(!!space.review); const [reviewAddress, setReviewAddress] = useState(space.review?.url || 'http://127.0.0.1:8765/');
  const validReview = reviewUrl(reviewAddress);
  const [materialRoots, setMaterialRoots] = useState(space.materialRoots || []);
  const retained = space.surfaces.filter(s => !['graph', 'tasks', 'session'].includes(s.integrationId));
  return <Dialog title="自定工作区" onClose={onClose}><form onSubmit={event => {event.preventDefault(); if (name.trim() && (!reviewEnabled || validReview) && materialRoots.every(r=>r.name.trim()) && new Set(materialRoots.map(r=>r.name.trim())).size===materialRoots.length) onSave(name.trim(), cwd || undefined, reviewEnabled ? {url: validReview!} : null, materialRoots);}}><label className="field">工作区名称<input autoFocus required maxLength={40} value={name} onChange={event => setName(event.target.value)}/></label>{agents && <section className="workspace-directory"><span>新会话工作目录</span><p>{cwd || '默认工作区目录'}</p><button type="button" className="outline-button" onClick={() => {void agents.chooseDirectory().then(value => {if (value) setCwd(value);});}}>选择文件夹</button></section>}{agents && <section className="workspace-directory"><span>材料目录 / Obsidian 库</span>{materialRoots.map((root, i) => <div className="material-root" key={root.path}><input aria-label="材料目录名称" value={root.name} maxLength={100} onChange={e => setMaterialRoots(all => all.map((r, index) => index===i ? {...r,name:e.target.value} : r))}/><small title={root.path}>{root.path}</small><button type="button" className="icon-button" aria-label={`解除目录${root.name}`} onClick={() => setMaterialRoots(all => all.filter((_, index) => index!==i))}><X size={13}/></button></div>)}<button type="button" className="outline-button" disabled={materialRoots.length>=20} onClick={() => {void agents.chooseDirectory().then(path => {if(path && !materialRoots.some(r=>r.path===path)) setMaterialRoots(all => [...all,{path,name:path.split(/[\\/]/).filter(Boolean).at(-1) || '笔记库'}]);});}}>添加目录</button><p className="quiet-note">库名与 Obsidian 链接里的库名保持一致。AI 可通过工作区工具读取关联材料。</p></section>}<section className="workspace-directory"><label><input type="checkbox" checked={reviewEnabled} onChange={e => setReviewEnabled(e.target.checked)}/> 跟踪本机 PR 检视</label>{reviewEnabled && <label className="field">服务地址<input aria-label="检视服务地址" value={reviewAddress} onChange={e => setReviewAddress(e.target.value)}/>{!validReview && <small role="alert">请输入本机 HTTP 地址，例如 http://127.0.0.1:8765/</small>}</label>}<p className="quiet-note">只读跟踪运行和报告，结果在通知中心查看。</p></section>{children}{!!retained.length && <><div className="section-label">原有视图内容已保留</div><div className="retained-content">{retained.map(s => <details key={s.id}><summary>{s.title}</summary><p>{s.text || s.url || '此组件的配置已保留，等待适配器接入。'}</p><button className="text-button" type="button" disabled={space.nodes.length >= 250} onClick={() => onPlace(s.title || '笔记', s.text || s.url || '', s.integrationId === 'note' ? 'document' : 'artifact')}>放到地图<Plus size={13}/></button></details>)}</div></>}<p className="quiet-note">地图节点与会话分别管理。分屏、页签顺序和当前会话随工作区保存。</p><footer><button className="primary-button" disabled={!name.trim() || (reviewEnabled && !validReview) || materialRoots.some(r=>!r.name.trim()) || new Set(materialRoots.map(r=>r.name.trim())).size!==materialRoots.length}>保存</button></footer></form></Dialog>;
}
