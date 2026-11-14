import {useCallback, useEffect, useRef, useState} from 'react';
import {Bell, ChevronDown, ChevronRight, CircleAlert, ExternalLink, Plus, Search, Settings2, Terminal, X} from 'lucide-react';
import {closeSessionTab, createMapNode, createSession, createWorkspace, initialWorkbench, openSession, selectWorkspaceTab, parseWorkbench, previousShellStorageKey, sessionNodeIds, shellStorageKey, updateWorkspace, type AgentSession, type GraphState, type WorkbenchState, type Workspace} from './core';
import {reconcileSessions} from './adapters';
import {GraphView, NodeGlyph, NodeInspector, NodeOverview} from './Graph';
import {agentNames, integrations} from './integrations';
import {parseState, storageKey, type MindNode} from './model';
import {SessionRow, SessionView, type ChangeState} from './Sessions';
import {DockLayout} from './DockLayout';
import {BrowserView, ReviewView} from './ToolViews';
import {closeDockTab, focusedGroup, openDockTab, selectDockTab, type DockTab} from './docking';
import {BackendPicker} from './BackendPicker';
import {NodeMaterials} from './NodeMaterials';
import {useNativeBrowserHost} from './native-browser';
import {AgentRuntimeContext, useAgentRuntime, useNativeAgents} from './NativeAgents';
import {Dialog, Empty, SpaceSymbol, Star} from './ui';

function loadWorkbench() {
  try {
    const raw = localStorage.getItem(shellStorageKey) || localStorage.getItem(previousShellStorageKey);
    if (raw) return {state: parseWorkbench(JSON.parse(raw)), error: ''};
    const legacy = localStorage.getItem(storageKey);
    return {state: initialWorkbench(legacy ? parseState(JSON.parse(legacy)) : undefined), error: ''};
  } catch {return {state: initialWorkbench(), error: '无法读取已保存的数据。本次使用临时状态，原始内容不会被覆盖。'};}
}
export default function Workbench() {
  const [loaded] = useState(loadWorkbench);
  const [state, setState] = useState(loaded.state);
  const current = useRef(state); current.current = state;
  const recentSwitch = useRef<{workspaceId: string; ids: string[]; index: number} | null>(null);
  const [dialog, setDialog] = useState<'workspace' | 'settings' | 'search' | 'link' | 'customize' | null>(null);
  const [newNodeId, setNewNodeId] = useState<string | null>(null);
  const [inbox, setInbox] = useState(false);
  const [saveError, setSaveError] = useState(loaded.error);
  const [saved, setSaved] = useState(false);
  const space = state.spaces.find(s => s.id === state.activeId)!;
  const selected = space.nodes.find(n => n.id === space.graph.selectedId);
  const sessions = state.sessions.filter(s => s.workspaceId === space.id);
  const unread = state.notices.filter(n => !n.read).length;
  const change: ChangeState = useCallback(update => setState(update), []);
  const nativeBrowsers = useNativeBrowserHost(state, change);
  const agents = useNativeAgents(state, change);
  const updateSpace = (update: (space: Workspace) => Workspace) => change(s => updateWorkspace(s, space.id, update));
  function save(value: WorkbenchState) {
    if (loaded.error) return;
    try {localStorage.setItem(shellStorageKey, JSON.stringify(value)); setSaveError(''); setSaved(true);} catch {setSaveError('保存失败：本地空间不足，当前修改仍保留在窗口中。'); setSaved(false);}
  }
  useEffect(() => {setSaved(false); const timer = setTimeout(() => save(state), 180); return () => clearTimeout(timer);}, [state]);
  useEffect(() => {
    const flush = () => save(current.current);
    const visibility = () => {if (document.visibilityState === 'hidden') flush();};
    window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', visibility);
    return () => {window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', visibility);};
  }, []);
  useEffect(() => {
    const tick = () => change(s => reconcileSessions(s, Date.now()));
    tick(); const timer = setInterval(tick, 500); return () => clearInterval(timer);
  }, [change]);
  function switchSpace(id: string) {change(s => ({...s, activeId: id})); setDialog(null); setNewNodeId(null); setInbox(false);}
  function openAgent(id: string) {
    change(s => {const next = openSession(s, id); return updateWorkspace(next, next.activeId, w => ({...w, sessionPanelOpen: false}));});
    setInbox(false); setDialog(null);
  }
  function startSession(agentId: AgentSession['agentId'], nodeId: string | null = null, groupId?: string) {
    const id = crypto.randomUUID(); const at = Date.now();
    change(s => {const target = groupId ? updateWorkspace(s, space.id, w => ({...w, dock: {...w.dock, activeGroupId: groupId}})) : s; const next = updateWorkspace(createSession(target, space.id, nodeId, id, at, agentId), space.id, w => ({...w, sessionPanelOpen: false})); return agents ? {...next, sessions: next.sessions.map(session => session.id === id ? {...session, integrationId: agentId || 'codex', cwd: space.cwd} : session)} : next;});
    if (agents) {const node = space.nodes.find(node => node.id === nodeId); agents.create({id, workspaceId: space.id, nodeId, backend: agentId || 'codex', title: node ? `${node.title} · 讨论` : '新的会话', cwd: space.cwd});}
    setInbox(false);
  }
  function changeGraph(graph: GraphState) {if (graph.selectedId !== newNodeId) setNewNodeId(null); updateSpace(s => ({...s, graph}));}
  function openNode(id: string) {
    setNewNodeId(null);
    change(s => selectWorkspaceTab(s, space.id));
    updateSpace(s => ({...s, graph: {...s.graph, selectedId: id, focusId: null, collapsed: [], camera: null}}));
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
  function createTab(kind: 'browser' | 'review' | NonNullable<AgentSession['agentId']>, groupId: string) {
    if (kind !== 'browser' && kind !== 'review') {startSession(kind, null, groupId); return;}
    const id = crypto.randomUUID();
    const tab: DockTab = kind === 'browser' ? {id, kind, title: '新标签页', url: ''} : {id, kind, title: '文件审查', files: []};
    updateSpace(w => ({...w, dock: openDockTab(w.dock, tab, groupId)}));
  }
  function updateTab(tab: DockTab) {updateSpace(w => ({...w, dock: {...w.dock, tabs: w.dock.tabs.map(t => t.id === tab.id ? tab : t)}}));}

  useEffect(() => {recentSwitch.current = null;}, [space.id]);
  function updateNode(node: MindNode) {updateSpace(s => ({...s, nodes: s.nodes.map(n => n.id === node.id ? node : n)}));}
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {event.preventDefault(); setDialog(d => d === 'search' ? null : 'search'); return;}
      if (dialog) return;
      if (event.altKey && !event.ctrlKey && /^[1-9]$/.test(event.key)) {const next = current.current.spaces[Number(event.key) - 1]; if (next) {event.preventDefault(); switchSpace(next.id);}}
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault();
        let cycle = recentSwitch.current;
        if (!cycle || cycle.workspaceId !== space.id) {const ids = [...new Set([focusedGroup(space.dock).activeId, ...[...space.dock.recent].reverse(), ...space.dock.tabs.map(t => t.id)])].filter(Boolean); cycle = {workspaceId: space.id, ids, index: 0}; recentSwitch.current = cycle;}
        cycle.index = (cycle.index + (event.shiftKey ? -1 : 1) + cycle.ids.length) % cycle.ids.length;
        selectTab(cycle.ids[cycle.index]); return;
      }
      if (event.ctrlKey && event.shiftKey && ['[', ']'].includes(event.key)) {
        event.preventDefault(); const group = focusedGroup(space.dock); const ids = group.tabs; if (!ids.length) return; selectTab(ids[(ids.indexOf(group.activeId) + (event.key === ']' ? 1 : -1) + ids.length) % ids.length]); return;
      }
      if (event.key === 'Escape') {
        if (inbox) setInbox(false);
        else if (space.sessionPanelOpen) updateSpace(w => ({...w, sessionPanelOpen: false}));
        else changeGraph({...space.graph, selectedId: null});
      }
    };
    const release = (event: KeyboardEvent) => {if (event.key === 'Control') recentSwitch.current = null;};
    document.addEventListener('keydown', listener); document.addEventListener('keyup', release); return () => {document.removeEventListener('keydown', listener); document.removeEventListener('keyup', release);};
  }, [dialog, inbox, space]);
  const nodeSessions = selected ? sessions.filter(s => sessionNodeIds(s).includes(selected.id)) : [];
  const sessionCounts: Record<string, number> = {};
  for (const session of sessions) for (const id of sessionNodeIds(session)) sessionCounts[id] = (sessionCounts[id] || 0) + 1;
  const mapView = <div className="workspace-map-scene">
      <main className="workspace-map" aria-label="工作区"><GraphView key={space.id} space={space} onChange={changeGraph} onAdd={parentId => {if (space.nodes.length >= 250) return; const id = crypto.randomUUID(); change(s => createMapNode(s, space.id, parentId, id)); setNewNodeId(id);}} sessionCounts={sessionCounts}/></main>
      {selected && <NodeInspector key={`${space.id}-${selected.id}`} space={space} node={selected} autoFocusTitle={newNodeId === selected.id} onChange={updateNode} onClose={() => changeGraph({...space.graph, selectedId: null})} onFocus={() => changeGraph({...space.graph, focusId: selected.id, selectedId: null, collapsed: [], camera: null})}>
        <div className="inspector-scroll unified-node-details"><div className="node-content-summary"><NodeGlyph kind={selected.kind} size={19}/><p>{selected.body || '在这里留下想法、内容或完成条件。'}</p></div><details className="node-edit-section"><summary>编辑节点内容</summary><NodeOverview key={selected.id} node={selected} onChange={updateNode}/></details>
          <NodeMaterials key={selected.id} node={selected} onChange={updateNode}/>
          <section className="node-detail-section"><div className="detail-section-heading"><h3>关联会话（{nodeSessions.length}）</h3></div><BackendPicker text="新建会话" label={`在${selected.title}中新建会话`} onChoose={agent => startSession(agent, selected.id)} onOpen={() => {setInbox(false); updateSpace(w => ({...w, sessionPanelOpen: false}));}} onLink={() => setDialog('link')}/>{nodeSessions.map(session => <SessionRow key={session.id} state={state} session={session} onOpen={() => openAgent(session.id)}/>)}{!nodeSessions.length && <p className="quiet-note">还没有关联会话</p>}</section>
          <section className="node-detail-section"><div className="detail-section-heading"><h3>更新记录</h3></div><div className="node-timeline">{[...(selected.updates || [])].reverse().map(update => {const source = sessions.find(s => s.id === update.sessionId); return <div key={update.id}><strong>{update.text}</strong><small>{new Date(update.at).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})} · {source ? `${agentNames[source.agentId || 'codex']}${source.integrationId === 'demo-agent' ? '（模拟）' : ''}` : '我'}</small>{source && <button className="text-button" onClick={() => openAgent(source.id)}>查看来源会话<ChevronRight size={12}/></button>}</div>;})}{!selected.updates?.length && <p className="quiet-note">执行结果与手动记录会留在这里</p>}</div><ProgressForm onSubmit={text => {const id = crypto.randomUUID(); const at = Date.now(); updateNode({...selected, updates: [...(selected.updates || []), {id, text, at}]});}}/></section>
        </div>
      </NodeInspector>}
    </div>;
  return <AgentRuntimeContext.Provider value={agents}><div className="workbench-shell map-first-shell">
    <aside className="shell-sidebar" aria-label="主导航"><div className="sidebar-brand"><Star/><span>北极星</span></div>
      <nav className="global-navigation"><button onClick={() => setDialog('workspace')} disabled={state.spaces.length >= 20}><Plus size={17}/>新建工作区</button><button onClick={() => setDialog('search')}><Search size={17}/>搜索<kbd>Ctrl K</kbd></button></nav>
      <div className="sidebar-label">工作区</div><nav className="workspace-list" aria-label="工作区">{state.spaces.map((item, index) => {
        const count = state.notices.filter(n => n.workspaceId === item.id && !n.read).length;
        const running = state.runs.some(r => r.state === 'running' && state.sessions.some(s => s.id === r.sessionId && s.workspaceId === item.id));
        return <button key={item.id} className={item.id === space.id ? 'active' : ''} aria-current={item.id === space.id ? 'page' : undefined} title={`${item.name}${index < 9 ? ` · Alt+${index + 1}` : ''}`} onClick={() => switchSpace(item.id)}><SpaceSymbol space={item}/><span>{item.name}</span>{count ? <span className="count-badge dark">{count}</span> : running ? <span className="running-dot" aria-label="有模拟任务运行中"/> : null}</button>;
      })}</nav><div className="sidebar-bottom"><span><span className="profile-avatar">我</span>个人空间</span><button onClick={() => setDialog('settings')}><Settings2 size={16}/>接入与设置</button><a href="/" target="_blank" rel="noreferrer"><ExternalLink size={14}/>原版北极星</a></div>
    </aside>
    <div className="shell-body"><header className="workspace-heading dock-workspace-heading"><div className="workspace-title-row"><h1>{space.name}</h1><div className="workspace-actions"><button className={`session-panel-toggle ${space.sessionPanelOpen ? 'active' : ''}`} aria-expanded={space.sessionPanelOpen} aria-controls="workspace-session-panel" onClick={() => updateSpace(w => ({...w, sessionPanelOpen: !w.sessionPanelOpen}))}>会话记录（{sessions.length}）<ChevronDown size={14}/>{sessions.some(s => s.unread) && <i className="unread-dot"/>}</button><span className="vertical-divider"/><button className="icon-button bell-button" aria-label={`通知${unread ? `，${unread}条未读` : ''}`} aria-expanded={inbox} onClick={() => setInbox(v => !v)}><Bell size={18}/>{!!unread && <span>{unread}</span>}</button><button className="text-button" onClick={() => setDialog('customize')}><Settings2 size={16}/><span>自定工作区</span></button></div></div></header>
    <div className="workspace-body workspace-map-body dock-workspace-body">
      <DockLayout key={space.id} state={state} space={space} onChange={update => updateSpace(w => ({...w, dock: update(w.dock)}))} onSelect={selectTab} onClose={closeTab} onCreate={createTab} render={(tab, active) => {
        if (tab.kind === 'map') return mapView;
        if (tab.kind === 'browser') return <BrowserView tab={tab} active={active} onChange={updateTab} native={nativeBrowsers}/>;
        if (tab.kind === 'review') return <ReviewView tab={tab} onChange={updateTab}/>;
        const session = state.sessions.find(s => s.id === tab.sessionId)!;
        return <SessionView state={state} session={session} active={active} change={change} onNode={id => {const nodeId = id || session.nodeId; if (nodeId) openNode(nodeId);}}/>;
      }}/>
      {space.sessionPanelOpen && <aside className="workspace-session-panel" id="workspace-session-panel" aria-label="当前工作区会话"><header><h2>会话记录（{sessions.length}）</h2><button className="icon-button" aria-label="收起会话面板" onClick={() => updateSpace(w => ({...w, sessionPanelOpen: false}))}><X size={16}/></button></header><p className="quiet-note">{space.name} · 关闭页签后仍可在这里重新打开</p><div className="workspace-session-list">{sessions.map(session => <SessionRow key={session.id} state={state} session={session} onOpen={() => openAgent(session.id)}/>)}{!sessions.length && <Empty title="还没有会话"><p>点“＋”选择后端开始。</p></Empty>}</div></aside>}

    </div>
    <footer className="shell-status"><span>{saveError ? <><CircleAlert size={12}/>{saveError}<button onClick={() => save(state)}>重试保存</button></> : <><span className="saved-dot"/>{saved ? '已保存到本机' : '正在保存'}</>}</span><span>Alt + 1…9 切换工作区 · Ctrl + Tab 切换最近页签</span></footer></div>
    {inbox && <aside className="notification-panel" aria-label="通知中心"><header><h2>通知</h2><button className="text-button" onClick={() => change(s => ({...s, notices: s.notices.map(n => ({...n, read: true})), sessions: s.sessions.map(session => ({...session, unread: false}))}))}>全部已读</button><button className="icon-button" aria-label="关闭通知中心" onClick={() => setInbox(false)}><X size={16}/></button></header>{[...state.notices].reverse().map(n => <button key={n.id} className={`notice-row ${n.read ? '' : 'unread'}`} onClick={() => openAgent(n.sessionId)}><Bell size={15}/><span><strong>{n.title}</strong><small>{state.sessions.find(s => s.id === n.sessionId)?.title}</small></span><ChevronRight size={14}/></button>)}{!state.notices.length && <Empty title="这里暂时很安静"/>}</aside>}
    {dialog === 'workspace' && <WorkspaceDialog onClose={() => setDialog(null)} onCreate={name => {const next = createWorkspace(name, 'blank'); change(s => ({...s, activeId: next.id, spaces: [...s.spaces, next]})); setDialog(null);}}/>}

    {dialog === 'settings' && <Dialog title="接入与设置" onClose={() => setDialog(null)}><p className="muted">{agents ? '使用本机已安装的执行器。会话、来源标识和执行记录由北极星保存。' : '浏览器模式使用模拟器；真实 Agent 请在 Windows 版中操作。'}</p><div className="integration-list">{integrations.filter(i => ['codex', 'claude', 'pi'].includes(i.id)).map(i => <div key={i.id}><Terminal size={16}/><span><strong>{i.name}</strong><small>{i.description}</small></span><span className="small-tag">{agents?.backends.find(backend => backend.id === i.id)?.available ? '已就绪' : '待接入'}</span></div>)}</div><p className="quiet-note">原版业务数据未迁移。地图、会话和更新记录保存在本机；当前页面不提供系统后台托管。</p></Dialog>}
    {dialog === 'customize' && <CustomizeDialog space={space} onClose={() => setDialog(null)} onSave={(name, cwd) => {updateSpace(w => ({...w, name, cwd})); setDialog(null);}} onPlace={(title, body, kind) => {const node: MindNode = {id: crypto.randomUUID(), parentId: space.nodes.find(n => !n.parentId)!.id, side: 1, kind, title, body, progress: 0, due: '', steps: []}; updateSpace(w => ({...w, nodes: [...w.nodes, node], graph: {...w.graph, selectedId: node.id, camera: null}})); change(s => selectWorkspaceTab(s, space.id)); setDialog(null);}}/>}
    {dialog === 'search' && <SearchDialog space={space} onClose={() => setDialog(null)} onOpen={openNode}/>}
    {dialog === 'link' && selected && <Dialog title="关联工作区会话" onClose={() => setDialog(null)}><p className="muted">从当前工作区选择已有会话，关联到「{selected.title}」。</p>{sessions.filter(s => !sessionNodeIds(s).includes(selected.id)).map(session => <SessionRow key={session.id} state={state} session={session} onOpen={() => {change(s => ({...s, sessions: s.sessions.map(item => item.id === session.id ? {...item, linkedNodeIds: [...(item.linkedNodeIds || []), selected.id]} : item)})); setDialog(null);}}/>)}{!sessions.some(s => !sessionNodeIds(s).includes(selected.id)) && <p className="quiet-note">暂无其他会话。可在节点的“＋”中选择后端创建。</p>}</Dialog>}

  </div></AgentRuntimeContext.Provider>;
}
function WorkspaceDialog({onClose, onCreate}: {onClose: () => void; onCreate: (name: string) => void}) {
  const [name, setName] = useState('');
  return <Dialog title="新建工作区" onClose={onClose}><form onSubmit={event => {event.preventDefault(); if (name.trim()) onCreate(name.trim());}}><label className="field">工作区名称<input autoFocus required maxLength={40} placeholder="给一件重要的事，留出空间" value={name} onChange={event => setName(event.target.value)}/></label><p className="quiet-note">从一个地图中心开始，按需添加节点与会话。</p><footer><button className="primary-button" disabled={!name.trim()}>创建工作区</button></footer></form></Dialog>;
}

function ProgressForm({onSubmit}: {onSubmit: (text: string) => void}) {
  const [text, setText] = useState('');
  return <form className="node-progress-form" onSubmit={event => {event.preventDefault(); if (text.trim()) {onSubmit(text.trim()); setText('');}}}><input aria-label="更新记录内容" placeholder="记录一点进展" maxLength={1000} value={text} onChange={event => setText(event.target.value)}/><button className="icon-button" aria-label="追加更新记录" disabled={!text.trim()}><Plus size={15}/></button></form>;
}
function SearchDialog({space, onClose, onOpen}: {space: Workspace; onClose: () => void; onOpen: (id: string) => void}) {
  const [query, setQuery] = useState('');
  return <Dialog title="搜索当前工作区" onClose={onClose}><input className="search-field" autoFocus aria-label="搜索节点" placeholder="搜索节点与内容" value={query} onChange={event => setQuery(event.target.value)}/><div className="view-library">{space.nodes.filter(n => `${n.title} ${n.body}`.includes(query)).map(n => <button key={n.id} onClick={() => onOpen(n.id)}><NodeGlyph kind={n.kind} size={16}/><span>{n.title}</span><ChevronRight size={14}/></button>)}</div></Dialog>;
}
function CustomizeDialog({space, onClose, onSave, onPlace}: {space: Workspace; onClose: () => void; onSave: (name: string, cwd?: string) => void; onPlace: (title: string, body: string, kind: 'document' | 'artifact') => void}) {
  const [name, setName] = useState(space.name);
  const agents = useAgentRuntime(); const [cwd, setCwd] = useState(space.cwd || '');
  const retained = space.surfaces.filter(s => !['graph', 'tasks', 'session'].includes(s.integrationId));
  return <Dialog title="自定工作区" onClose={onClose}><form onSubmit={event => {event.preventDefault(); if (name.trim()) onSave(name.trim(), cwd || undefined);}}><label className="field">工作区名称<input autoFocus required maxLength={40} value={name} onChange={event => setName(event.target.value)}/></label>{agents && <section className="workspace-directory"><span>新会话工作目录</span><p>{cwd || '默认工作区目录'}</p><button type="button" className="outline-button" onClick={() => {void agents.chooseDirectory().then(value => {if (value) setCwd(value);});}}>选择文件夹</button></section>}{!!retained.length && <><div className="section-label">原有视图内容已保留</div><div className="retained-content">{retained.map(s => <details key={s.id}><summary>{s.title}</summary><p>{s.text || s.url || '此组件的配置已保留，等待适配器接入。'}</p><button className="text-button" type="button" disabled={space.nodes.length >= 250} onClick={() => onPlace(s.title || '笔记', s.text || s.url || '', s.integrationId === 'note' ? 'document' : 'artifact')}>放到地图<Plus size={13}/></button></details>)}</div></>}<p className="quiet-note">地图节点与会话分别管理。分屏、页签顺序和当前会话随工作区保存。</p><footer><button className="primary-button" disabled={!name.trim()}>保存</button></footer></form></Dialog>;
}
