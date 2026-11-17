import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {BookOpen, Bell, ChevronDown, ChevronRight, CircleAlert, ExternalLink, Plus, Search, Settings2, Terminal, X} from 'lucide-react';
import {addSubtask, closeSessionTab, createMapNode, createSession, createWorkspace, initialWorkbench, mapGraph, openMapTab, openSession, selectWorkspaceTab, parseWorkbench, previousShellStorageKey, reviewUrl, editNodeBody, renameMapNode, sessionNodeIds, shellStorageKey, setTaskProgress, updateMapGraph, updateWorkspace, type AgentSession, type GraphState, type Notice, type Workspace} from './core';
import {reconcileSessions} from './adapters';
import {GraphView, NodeGlyph, NodeInspector, NodeOverview, TasksView} from './Graph';
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
import {AgentRuntimeContext, useAgentRuntime, useNativeAgents} from './NativeAgents';
import {useNativeBackground} from './NativeBackground';
import {ReportView} from './ReportView';
import {MaterialView} from './MaterialView';
import {parseMaterialTarget, type NodeMaterial} from './material-target';
import {useMapOperations} from './map-operations';
import {BusinessView} from './BusinessView';
import {useKnowledgeCollection} from './KnowledgeCollection';
const personalKnowledgeTab:Extract<DockTab,{kind:'business'}>={id:'knowledge',kind:'business',page:'knowledge',title:'个人知识库'};
import {businessComponents,isBusinessPage,type BusinessPage} from '../business-components';
import {fromTemplate,layoutTemplate} from './composition';
import {CompositionSettings} from './CompositionSettings';
import {boundedText} from './text';
import {Dialog, Empty, SpaceSymbol, Star} from './ui';

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
  const [loaded] = useState(loadWorkbench);
  const [state, setState] = useState(loaded.state);
  const current = useRef(state); current.current = state;
  const recentSwitch = useRef<{workspaceId: string; ids: string[]; index: number} | null>(null);
  const [dialog, setDialog] = useState<'workspace' | 'settings' | 'search' | 'link' | 'customize' | null>(null);
  const [newNodeId, setNewNodeId] = useState<string | null>(null);
  const [inbox, setInbox] = useState(false);
  const [knowledgeOpen,setKnowledgeOpen]=useState(false);
  const [knowledgeVisited,setKnowledgeVisited]=useState(false);
  const space = state.spaces.find(s => s.id === state.activeId)!;
  const focusedTabId = focusedGroup(space.dock).activeId;
  const selected = space.nodes.find(n => n.id === mapGraph(space, focusedTabId).selectedId);
  const sessions = state.sessions.filter(s => s.workspaceId === space.id);
  const unread = state.notices.filter(n => !n.read).length;
  const change: ChangeState = useCallback(update => setState(update), []);
  const persistence = useWorkbenchPersistence(state, change, loaded.error);
  const knowledge=useKnowledgeCollection(state,persistence.ready&&!persistence.readOnly&&persistence.saved);
  const nativeBrowsers = useNativeBrowserHost(state, change, persistence.ready);
  const agents = useNativeAgents(state, change, persistence.ready,!knowledgeOpen);
  const background = useNativeBackground(state, change, persistence.ready, openNotice);
  const mapError = useMapOperations(state, change, persistence.ready);
  const updateSpace = (update: (space: Workspace) => Workspace) => change(s => updateWorkspace(s, space.id, update));
  useEffect(() => {
    if (!persistence.ready) return;
    const tick = () => change(s => reconcileSessions(s, Date.now()));
    tick(); const timer = setInterval(tick, 500); return () => clearInterval(timer);
  }, [change, persistence.ready]);
  function switchSpace(id: string) {setKnowledgeOpen(false);change(s => ({...s, activeId: id})); setDialog(null); setNewNodeId(null); setInbox(false);}
  function openAgent(id: string) {
    setKnowledgeOpen(false);
    change(s => {const next = openSession(s, id); return updateWorkspace(next, next.activeId, w => ({...w, sessionPanelOpen: false}));});
    setInbox(false); setDialog(null);
  }
  function openReport(workspaceId: string, url: string, file: string) {
    setKnowledgeOpen(false);
    change(s => ({...updateWorkspace(s, workspaceId, w => ({...w, dock: openDockTab(w.dock, {id: `report:${url}:${file}`, kind: 'report', title: 'PR 检视报告', url, file})})), activeId: workspaceId}));
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
  function openMaterial(material: NodeMaterial, selected: MindNode) {
    const parsed=parseMaterialTarget(material.target);
    const tab: DockTab=parsed.kind==='web' ? {id:crypto.randomUUID(),kind:'browser',title:material.title || parsed.title,url:parsed.target} : {id:`material:${selected.id}:${material.id}`,kind:'material',title:material.title || parsed.title,nodeId:selected.id,materialId:material.id};
    updateSpace(w=>({...w,dock:openDockTab(w.dock,tab)}));
  }

  useEffect(() => {recentSwitch.current = null;}, [space.id]);
  function updateNode(node: MindNode) {updateSpace(s => ({...s, nodes: s.nodes.map(n => n.id === node.id ? node : n)}));}
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
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
        if (!cycle || cycle.workspaceId !== space.id) {const ids = [...new Set([focusedGroup(space.dock).activeId, ...[...space.dock.recent].reverse(), ...space.dock.tabs.map(t => t.id)])].filter(Boolean); cycle = {workspaceId: space.id, ids, index: 0}; recentSwitch.current = cycle;}
        cycle.index = (cycle.index + (event.shiftKey ? -1 : 1) + cycle.ids.length) % cycle.ids.length;
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
    const changeView = (graph: GraphState) => changeGraph(graph, tab.id);
    return <div className="workspace-map-scene">
      <main className="workspace-map" aria-label="工作区"><GraphView key={`${space.id}-${tab.id}`} space={{...space, graph}} onChange={changeView} onInspect={id=>{setNewNodeId(null);changeView({...graph,selectedId:id});}} onRename={(id,title)=>change(s=>renameMapNode(s,space.id,id,title))} autoEditId={newNodeId === graph.selectedId ? newNodeId : null} onAdd={parentId => {if (space.nodes.length >= 250) return; const id = crypto.randomUUID(); change(s => createMapNode(s, space.id, parentId, id, tab.id)); setNewNodeId(id);}} sessionCounts={sessionCounts}/></main>
      {selected && <NodeInspector key={`${space.id}-${selected.id}`} space={space} node={selected} onEditBody={value=>change(s=>editNodeBody(s,space.id,selected.id,value))} onClose={() => changeView({...graph, selectedId: null})} onFocus={() => changeView({...graph, focusId: selected.id, selectedId: null, collapsed: [], camera: null})}>
        <div className="inspector-scroll unified-node-details"><NodeOverview key={selected.id} space={space} node={selected} onProgress={(id,progress)=>change(s=>setTaskProgress(s,space.id,id,progress))} onDue={due=>updateSpace(w=>({...w,nodes:w.nodes.map(n=>n.id===selected.id?{...n,due}:n)}))} onOpen={id=>changeView({...graph,selectedId:id,focusId:null,camera:null})} onAdd={()=>{const id=crypto.randomUUID();change(s=>{const next=addSubtask(s,space.id,selected.id,id);return next===s?s:updateWorkspace(next,space.id,w=>updateMapGraph(w,{...mapGraph(w,tab.id),selectedId:id,focusId:null,collapsed:graph.collapsed.filter(value=>value!==selected.id),camera:null},tab.id));});setNewNodeId(id);}}/>
          <NodeMaterials key={selected.id} node={selected} onChange={updateNode} onOpen={material => openMaterial(material, selected)}/>
          <section className="node-detail-section"><div className="detail-section-heading"><h3>关联会话（{nodeSessions.length}）</h3></div><BackendPicker text="新建会话" label={`在${selected.title}中新建会话`} onChoose={agent => startSession(agent, selected.id)} onOpen={() => {setInbox(false); updateSpace(w => ({...w, sessionPanelOpen: false}));}} onLink={() => setDialog('link')}/>{nodeSessions.map(session => <SessionRow key={session.id} state={state} session={session} onOpen={() => openAgent(session.id)}/>)}{!nodeSessions.length && <p className="quiet-note">还没有关联会话</p>}</section>
          <section className="node-detail-section"><div className="detail-section-heading"><h3>更新记录</h3></div><div className="node-timeline">{[...(selected.updates || [])].reverse().map(update => {const source = sessions.find(s => s.id === update.sessionId); return <div key={update.id}><strong>{update.text}</strong><small>{update.at === 0 && update.id.startsWith('migration-') ? '旧数据迁移' : new Date(update.at).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})} · {source ? `${agentNames[source.agentId || 'codex']}${source.integrationId === 'demo-agent' ? '（模拟）' : ''}` : '我'}</small>{source && <button className="text-button" onClick={() => openAgent(source.id)}>查看来源会话<ChevronRight size={12}/></button>}</div>;})}{!selected.updates?.length && <p className="quiet-note">执行结果与手动记录会留在这里</p>}</div><ProgressForm onSubmit={text => {const id = crypto.randomUUID(); const at = Date.now(); updateNode({...selected, updates: [...(selected.updates || []), {id, text, at}]});}}/></section>
        </div>
      </NodeInspector>}
    </div>;
  }
  if (!persistence.ready) return <div className="workbench-loading">正在恢复工作区…</div>;
  return <AgentRuntimeContext.Provider value={agents?{...agents,readOnly:persistence.readOnly,backends:persistence.readOnly?[]:agents.backends}:null}><div className="workbench-shell map-first-shell">
    <aside className="shell-sidebar" aria-label="主导航"><div className="sidebar-brand"><Star/><span>北极星</span></div>
      <nav className="global-navigation"><button onClick={() => {setKnowledgeOpen(false);setDialog('workspace');}} disabled={state.spaces.length >= 20}><Plus size={17}/>新建工作区</button><button onClick={() => setDialog('search')}><Search size={17}/>搜索<kbd>Ctrl K</kbd></button><button className={knowledgeOpen?'active':''} aria-current={knowledgeOpen?'page':undefined} onClick={()=>{setKnowledgeVisited(true);setKnowledgeOpen(true);setDialog(null);setInbox(false);}}><BookOpen size={17}/>个人知识库</button></nav>
      <div className="sidebar-label">工作区</div><nav className="workspace-list" aria-label="工作区">{state.spaces.map((item, index) => {
        const count = state.notices.filter(n => n.workspaceId === item.id && !n.read).length;
        const running = state.runs.some(r => r.state === 'running' && state.sessions.some(s => s.id === r.sessionId && s.workspaceId === item.id)) || !!(item.review && background.reviews[item.id]?.runningCount);
        return <button key={item.id} className={!knowledgeOpen&&item.id === space.id ? 'active' : ''} aria-current={!knowledgeOpen&&item.id === space.id ? 'page' : undefined} title={`${item.name}${index < 9 ? ` · Alt+${index + 1}` : ''}`} onClick={() => switchSpace(item.id)}><SpaceSymbol space={item}/><span>{item.name}</span>{count ? <span className="count-badge dark">{count}</span> : running ? <span className="running-dot" aria-label="有任务运行中"/> : null}</button>;
      })}</nav><div className="sidebar-bottom"><span><span className="profile-avatar">我</span>个人空间</span><button onClick={() => setDialog('settings')}><Settings2 size={16}/>接入与设置</button><button onClick={()=>openBusiness('overview')}><ExternalLink size={14}/>个人工作台</button></div>
    </aside>
    <div className="shell-body"><header className="workspace-heading dock-workspace-heading"><div className="workspace-title-row"><h1>{knowledgeOpen?'个人知识库':space.name}</h1><div className="workspace-actions">{!knowledgeOpen&&<><button className={`session-panel-toggle ${space.sessionPanelOpen ? 'active' : ''}`} aria-expanded={space.sessionPanelOpen} aria-controls="workspace-session-panel" onClick={() => updateSpace(w => ({...w, sessionPanelOpen: !w.sessionPanelOpen}))}>会话记录（{sessions.length}）<ChevronDown size={14}/>{sessions.some(s => s.unread) && <i className="unread-dot"/>}</button><span className="vertical-divider"/></>}<button className="icon-button bell-button" aria-label={`通知${unread ? `，${unread}条未读` : ''}`} aria-expanded={inbox} onClick={() => setInbox(v => !v)}><Bell size={18}/>{!!unread && <span>{unread}</span>}</button>{!knowledgeOpen&&<button className="text-button" onClick={() => setDialog('customize')}><Settings2 size={16}/><span>自定工作区</span></button>}</div></div></header>
    <div className="workspace-body workspace-map-body dock-workspace-body">
      <div className="workspace-content-host" hidden={knowledgeOpen}><DockLayout key={space.id} state={state} space={space} onChange={update => updateSpace(w => ({...w, dock: update(w.dock)}))} onSelect={selectTab} onClose={closeTab} onCreate={createTab} render={(tab, active) => {
        if (tab.kind === 'map') return mapView(tab);
        if (tab.kind === 'events') return <TasksView space={space} onOpen={openNode}/>;
        if (tab.kind === 'browser') return <BrowserView tab={tab} active={active&&!knowledgeOpen} onChange={updateTab} native={nativeBrowsers}/>;
        if (tab.kind === 'review') return <ReviewView workspaceId={space.id} tab={tab} onChange={updateTab}/>;
        if (tab.kind === 'material') return <MaterialView workspaceId={space.id} tab={tab}/>;
        if (tab.kind === 'business') return <BusinessView workspaceId={space.id} tab={tab} active={active&&!knowledgeOpen} onChange={updateTab} flush={persistence.flush} onWorkspace={()=>change(s=>selectWorkspaceTab(s,space.id))}/>;
        if (tab.kind === 'report') return <ReportView workspaceId={space.id} tab={tab} onDashboard={() => updateSpace(w => ({...w, dock: openDockTab(w.dock, {id: w.dock.tabs.find(t=>t.kind==='browser'&&t.url===tab.url)?.id||crypto.randomUUID(), kind: 'browser', title: 'PR 检视看板', url: tab.url})}))}/>;
        const session = state.sessions.find(s => s.id === tab.sessionId)!;
        return <SessionView state={state} session={session} active={active&&!knowledgeOpen} change={change} onNode={id => {const nodeId = id || session.nodeId; if (nodeId) openNode(nodeId);}}/>;
      }}/></div>
      {knowledgeVisited&&<div className="personal-knowledge-host" hidden={!knowledgeOpen}>{knowledge.error&&<p className="knowledge-collection-error" role="alert">{knowledge.error}<button className="text-button" onClick={knowledge.retry}>重试入库</button></p>}<BusinessView workspaceId="personal" tab={personalKnowledgeTab} active={knowledgeOpen} onChange={tab=>{if(tab.kind==='business'&&tab.page!=='knowledge'){setKnowledgeVisited(false);openBusiness(tab.page);}}} flush={persistence.flush} onWorkspace={()=>setKnowledgeOpen(false)}/></div>}
      {!knowledgeOpen&&space.sessionPanelOpen && <aside className="workspace-session-panel" id="workspace-session-panel" aria-label="当前工作区会话"><header><h2>会话记录（{sessions.length}）</h2><button className="icon-button" aria-label="收起会话面板" onClick={() => updateSpace(w => ({...w, sessionPanelOpen: false}))}><X size={16}/></button></header><p className="quiet-note">{space.name} · 关闭页签后仍可在这里重新打开</p><div className="workspace-session-list">{sessions.map(session => <SessionRow key={session.id} state={state} session={session} onOpen={() => openAgent(session.id)}/>)}{!sessions.length && <Empty title="还没有会话"><p>点“＋”选择后端开始。</p></Empty>}</div></aside>}

    </div>
    <footer className="shell-status"><span>{(persistence.error || mapError) ? <><CircleAlert size={12}/>{persistence.error || mapError}<button onClick={persistence.retry}>{persistence.readOnly ? '重试读取' : '重试保存'}</button></> : <><span className="saved-dot"/>{persistence.saved ? '已保存到本机' : '正在保存'}</>}</span><span>Alt + 1…9 切换工作区 · Ctrl + Tab 切换最近页签</span></footer></div>
    {inbox && <aside className="notification-panel" aria-label="通知中心"><header><h2>通知</h2><button className="text-button" onClick={() => change(s => ({...s, notices: s.notices.map(n => ({...n, read: true})), sessions: s.sessions.map(session => ({...session, unread: false}))}))}>全部已读</button><button className="icon-button" aria-label="关闭通知中心" onClick={() => setInbox(false)}><X size={16}/></button></header>{background.error && <p className="tool-error" role="alert">{background.error}</p>}{state.spaces.filter(w => w.review).map(w => {const status = background.reviews[w.id]; return <div className="review-status" key={w.id}><strong>{w.name}</strong><small>{!status ? agents ? '正在连接检视服务' : '请在 Windows 版跟踪状态' : !status.connected ? `连接中断 · ${status.error}` : status.error || `${status.runningCount} 个 PR 处理中${status.paused ? ' · 已暂停调度' : ''}`}</small>{status?.historyGap && <small>离线期间可能有遗漏，请查看原看板。</small>}{status?.reports.slice(0, 5).map(report => <button className="text-button" key={report.file} onClick={() => openReport(w.id, status.url, report.file)}>{report.prs.map(n => `#${n}`).join('、') || '检视报告'} · {report.state === 'running' ? '进行中' : report.state === 'succeeded' ? '已完成' : report.state === 'failed' ? '失败' : '状态待确认'}<ChevronRight size={12}/></button>)}</div>;})}{[...state.notices].reverse().map(n => <button key={n.id} className={`notice-row ${n.read ? '' : 'unread'}`} onClick={() => openNotice(n)}><Bell size={15}/><span><strong>{n.title}</strong><small>{n.body || state.sessions.find(s => s.id === n.sessionId)?.title || state.spaces.find(w => w.id === n.workspaceId)?.name}</small></span><ChevronRight size={14}/></button>)}{!state.notices.length && <Empty title="这里暂时很安静"/>}</aside>}
    {dialog === 'workspace' && <WorkspaceDialog templates={state.templates} onClose={() => setDialog(null)} onCreate={(name,templateId) => {const template=state.templates?.find(t=>t.id===templateId);const next = template?fromTemplate(name,template):createWorkspace(name, 'blank'); change(s => ({...s, activeId: next.id, spaces: [...s.spaces, next]})); setDialog(null);}}/>}

    {dialog === 'settings' && <Dialog title="接入与设置" onClose={() => setDialog(null)}><p className="muted">{agents ? '使用本机已安装的执行器。会话、来源标识和执行记录由北极星保存。' : '浏览器模式使用模拟器；真实 Agent 请在 Windows 版中操作。'}</p><div className="integration-list">{integrations.filter(i => ['codex', 'claude', 'pi'].includes(i.id)).map(i => <div key={i.id}><Terminal size={16}/><span><strong>{i.name}</strong><small>{i.description}</small></span><span className="small-tag">{agents?.backends.find(backend => backend.id === i.id)?.available ? '已发现' : '未发现'}</span></div>)}</div><p className="quiet-note">地图、会话和更新记录保存在本机。Windows 版收起或切换工作区后继续执行；退出北极星会停止本机执行器。</p></Dialog>}
    {dialog === 'customize' && <CustomizeDialog space={space} onClose={() => setDialog(null)} onSave={(name, cwd, review, materialRoots) => {updateSpace(w => ({...w, name, cwd, review, materialRoots})); setDialog(null);}} onPlace={(title, body, kind) => {const node: MindNode = {id: crypto.randomUUID(), parentId: space.nodes.find(n => !n.parentId)!.id, side: 1, kind, title:boundedText(title,120), body, progress: 0, due: '', }; updateSpace(w => ({...w, nodes: [...w.nodes, node], graph: {...w.graph, selectedId: node.id, camera: null}})); change(s => selectWorkspaceTab(s, space.id)); setDialog(null);}}>
      <CompositionSettings workspaceName={space.name} templates={state.templates||[]} integrations={state.externalIntegrations||[]} onTemplate={name=>change(s=>{const old=s.templates?.find(t=>t.name===name);const template=layoutTemplate(space,old?.id||crypto.randomUUID(),name);return{...s,templates:[...(s.templates||[]).filter(t=>t.id!==template.id),template]};})} onRemoveTemplate={id=>change(s=>({...s,templates:s.templates?.filter(t=>t.id!==id)}))} onIntegration={integration=>change(s=>({...s,externalIntegrations:[...(s.externalIntegrations||[]).filter(i=>i.id!==integration.id),integration]}))} onRemoveIntegration={id=>change(s=>({...s,externalIntegrations:s.externalIntegrations?.filter(i=>i.id!==id)}))}/>
    </CustomizeDialog>}
    {dialog === 'search' && <SearchDialog space={space} onClose={() => setDialog(null)} onOpen={openNode}/>}
    {dialog === 'link' && selected && <Dialog title="关联工作区会话" onClose={() => setDialog(null)}><p className="muted">从当前工作区选择已有会话，关联到「{selected.title}」。</p>{sessions.filter(s => !sessionNodeIds(s).includes(selected.id)).map(session => <SessionRow key={session.id} state={state} session={session} onOpen={() => {change(s => ({...s, sessions: s.sessions.map(item => item.id === session.id ? {...item, linkedNodeIds: [...(item.linkedNodeIds || []), selected.id]} : item)})); setDialog(null);}}/>)}{!sessions.some(s => !sessionNodeIds(s).includes(selected.id)) && <p className="quiet-note">暂无其他会话。可在节点的“＋”中选择后端创建。</p>}</Dialog>}

  </div></AgentRuntimeContext.Provider>;
}
function WorkspaceDialog({onClose, onCreate, templates=[]}: {onClose: () => void; onCreate: (name: string, templateId: string) => void; templates?: {id:string;name:string}[]}) {
  const [name, setName] = useState('');
  const [templateId,setTemplateId]=useState('');
  return <Dialog title="新建工作区" onClose={onClose}><form onSubmit={event => {event.preventDefault(); if (name.trim()) onCreate(name.trim(),templateId);}}><label className="field">工作区名称<input autoFocus required maxLength={40} placeholder="给一件重要的事，留出空间" value={name} onChange={event => setName(event.target.value)}/></label>{!!templates.length&&<label className="field">布局模板<select value={templateId} onChange={e=>setTemplateId(e.target.value)}><option value="">空白工作区</option>{templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}<p className="quiet-note">从一个地图中心开始，按需添加节点与会话。</p><footer><button className="primary-button" disabled={!name.trim()}>创建工作区</button></footer></form></Dialog>;
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
