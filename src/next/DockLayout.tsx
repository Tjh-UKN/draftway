import {useEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Columns2, FileCode2, Globe, Layers, MessageSquare, Network, Plus, Rows2, Terminal, X} from 'lucide-react';
import {latestRun, statusNames, type AgentSession, type WorkbenchState, type Workspace} from './core';
import {closeEmptyGroup, groups, mergeDock, moveDockTab, resizeDock, splitDockGroup, type DockNode, type DockState, type DockTab, type Edge, type Split, type TabGroup} from './docking';
import {agentNames} from './integrations';
import {useAgentRuntime} from './NativeAgents';
import {businessComponents,type BusinessPage} from '../business-components';
import type {ExternalIntegration} from './integration-manifest';

const dragType = 'application/x-northstar-tab';
type CreateKind = 'browser' | 'review' | 'events' | NonNullable<AgentSession['agentId']> | `business:${BusinessPage}` | `integration:${string}`;
interface Props {
  state: WorkbenchState; space: Workspace;
  onChange: (update: (dock: DockState) => DockState) => void;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onCreate: (kind: CreateKind, groupId: string) => void;
  render: (tab: DockTab, active: boolean) => ReactNode;
}
export function DockLayout(props: Props) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {const end = () => setDragging(false); window.addEventListener('dragend', end); window.addEventListener('drop', end); return () => {window.removeEventListener('dragend', end); window.removeEventListener('drop', end);};}, []);
  function tree(node: DockNode): ReactNode {
    if (node.kind === 'split') return <SplitView key={node.id} node={node} onResize={ratio => props.onChange(dock => resizeDock(dock, node.id, ratio))}>{tree(node.children[0])}{tree(node.children[1])}</SplitView>;
    return <GroupView key={node.id} {...props} group={node} dragging={dragging} onDrag={setDragging}/>;
  }
  return <div className={`dock-layout ${dragging ? 'is-dragging' : ''}`}>{tree(props.space.dock.root)}</div>;
}
function SplitView({node, children, onResize}: {node: Split; children: ReactNode[]; onResize: (ratio: number) => void}) {
  const container = useRef<HTMLDivElement>(null);
  return <div ref={container} className={`dock-split split-${node.axis}`} style={{gridTemplateColumns: node.axis === 'row' ? `minmax(0, ${node.ratio}fr) 5px minmax(0, ${1 - node.ratio}fr)` : undefined, gridTemplateRows: node.axis === 'column' ? `minmax(0, ${node.ratio}fr) 5px minmax(0, ${1 - node.ratio}fr)` : undefined}}>
    {children[0]}<div className="dock-divider" role="separator" aria-label={node.axis === 'row' ? '调整左右分区大小' : '调整上下分区大小'} aria-orientation={node.axis === 'row' ? 'vertical' : 'horizontal'} aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(node.ratio * 100)} tabIndex={0} onKeyDown={event => {if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {event.preventDefault(); onResize(node.ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -.025 : .025));}}} onPointerDown={event => {
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); document.body.classList.add('resizing-panes');
    }} onPointerMove={event => {if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const rect = container.current!.getBoundingClientRect(); onResize(node.axis === 'row' ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height);}} onPointerUp={event => {event.currentTarget.releasePointerCapture(event.pointerId); document.body.classList.remove('resizing-panes');}} onLostPointerCapture={() => document.body.classList.remove('resizing-panes')}/>{children[1]}
  </div>;
}
function GroupView({group, dragging, onDrag, ...props}: Props & {group: TabGroup; dragging: boolean; onDrag: (value: boolean) => void}) {
  const {state, space, onChange, onSelect, onClose, onCreate, render} = props;
  const focused = space.dock.activeGroupId === group.id;
  const [edge, setEdge] = useState<Edge | 'center' | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'nearest', inline: 'nearest'});}, [group.activeId]);
  useEffect(() => {if (!dragging) setEdge(null);}, [dragging]);
  function focus() {if (!focused) onChange(dock => ({...dock, activeGroupId: group.id}));}
  function drop(id: string, beforeId?: string, side?: Edge) {if (space.dock.tabs.some(t => t.id === id)) onChange(dock => moveDockTab(dock, id, group.id, beforeId, side)); setEdge(null); onDrag(false);}
  return <section className={`dock-group ${focused ? 'focused' : ''}`} aria-label={`分区：${space.dock.tabs.find(t => t.id === group.activeId)?.title || '新分区'}`} data-group-id={group.id} onPointerDownCapture={focus} onFocusCapture={focus}>
    <header className="dock-group-header"><div className="dock-tab-strip" role="tablist" aria-label="分区页签" ref={strip} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]; const at = tabs.indexOf(document.activeElement as HTMLButtonElement); if (at < 0) return;
      event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[index].focus(); tabs[index].click();
    }} onDragOver={event => {if (event.dataTransfer.types.includes(dragType)) {event.preventDefault(); event.stopPropagation();}}} onDrop={event => {if (event.dataTransfer.types.includes(dragType)) {event.preventDefault(); event.stopPropagation(); drop(event.dataTransfer.getData(dragType));}}}>
      {group.tabs.map(id => {
        const tab = space.dock.tabs.find(t => t.id === id)!; const session = tab.kind === 'session' ? state.sessions.find(s => s.id === tab.sessionId) : undefined;
        const provider = session ? agentNames[session.agentId || 'codex'] : '';
        const title = session ? session.title : tab.title; const label = provider ? `${provider}：${title}` : title;
        const status = session ? latestRun(state, session.id)?.state || 'idle' : null;
        const active = group.activeId === id;
        return <div key={id} className={`dock-tab ${active ? 'active' : ''}`} draggable onDragStart={event => {event.dataTransfer.setData(dragType, id); event.dataTransfer.effectAllowed = 'move'; onDrag(true);}} onDragEnd={() => onDrag(false)} onDragOver={event => {if (event.dataTransfer.types.includes(dragType)) {event.preventDefault(); event.stopPropagation();}}} onDrop={event => {if (event.dataTransfer.types.includes(dragType)) {event.preventDefault(); event.stopPropagation(); drop(event.dataTransfer.getData(dragType), id);}}}>
          <button role="tab" id={`dock-tab-${space.id}-${id}`} aria-selected={active} aria-controls={`dock-panel-${space.id}-${id}`} tabIndex={active ? 0 : -1} aria-label={label} title={`${label}${status ? ` · ${statusNames[status]}` : ''}`} onClick={() => onSelect(id)} onAuxClick={event => {if (event.button === 1 && tab.kind !== 'map') {event.preventDefault(); onClose(id);}}}>
            {tab.kind === 'map' ? <Network size={14}/> : tab.kind === 'browser' ? <Globe size={14}/> : ['review', 'report'].includes(tab.kind) ? <FileCode2 size={14}/> : session?.agentId === 'codex' ? <Terminal size={14}/> : <MessageSquare size={14}/>}
            <span>{title}</span>{status && <i className={`tab-run-indicator run-${status} ${session?.unread ? 'has-unread' : ''}`} aria-label={session?.unread ? '未读结果' : statusNames[status]}/>}
          </button>{tab.kind !== 'map' && <button className="dock-tab-close" aria-label={`关闭${label}页签`} title={tab.kind === 'session' ? '关闭页签，保留会话记录' : '关闭页签'} onClick={() => onClose(id)}><X size={11}/></button>}
        </div>;
      })}
    </div><PaneMenu integrations={state.externalIntegrations||[]} onCreate={kind => onCreate(kind, group.id)} onSplit={axis => onChange(dock => splitDockGroup(dock, group.id, axis))} onMerge={() => onChange(mergeDock)} canSplit={groups(space.dock.root).length < 8} canMerge={space.dock.root.kind === 'split'}/>{!group.tabs.length && <button className="icon-button" aria-label="关闭空分区" onClick={() => onChange(dock => closeEmptyGroup(dock, group.id))}><X size={13}/></button>}</header>
    <div className="dock-group-content" onDragOver={event => {
      if (!event.dataTransfer.types.includes(dragType)) return; event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect(); const x = (event.clientX - rect.left) / rect.width; const y = (event.clientY - rect.top) / rect.height;
      setEdge(x < .2 ? 'left' : x > .8 ? 'right' : y < .2 ? 'top' : y > .8 ? 'bottom' : 'center');
    }} onDragLeave={event => {if (!event.currentTarget.contains(event.relatedTarget as Node)) setEdge(null);}} onDrop={event => {if (event.dataTransfer.types.includes(dragType)) {event.preventDefault(); drop(event.dataTransfer.getData(dragType), undefined, edge && edge !== 'center' ? edge : undefined);}}}>
      {group.tabs.map(id => {const tab = space.dock.tabs.find(t => t.id === id)!; return <div key={id} className={`dock-scene scene-${tab.kind}`} role="tabpanel" id={`dock-panel-${space.id}-${id}`} aria-labelledby={`dock-tab-${space.id}-${id}`} hidden={id !== group.activeId}>{render(tab, id === group.activeId && focused)}</div>;})}
      {!group.tabs.length && <div className="tool-empty"><p>从上方“＋”打开内容</p></div>}
      {dragging && <div className="dock-drop-capture"/>}{edge && <div className={`dock-drop-preview drop-${edge}`}><span>{edge === 'center' ? '移到这里' : edge === 'left' || edge === 'right' ? '左右分屏' : '上下分屏'}</span></div>}
    </div>
  </section>;
}
function PaneMenu({onCreate, onSplit, onMerge, canSplit, canMerge, integrations}: {integrations:ExternalIntegration[];onCreate: (kind: CreateKind) => void; onSplit: (axis: Split['axis']) => void; onMerge: () => void; canSplit: boolean; canMerge: boolean}) {
  const agents = useAgentRuntime();
  const [position, setPosition] = useState<{left: number; top: number} | null>(null);
  const [businessMenu,setBusinessMenu]=useState(false);
  const trigger = useRef<HTMLButtonElement>(null); const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position) return; menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: Event) => {if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setPosition(null);};
    const close = () => setPosition(null);
    document.addEventListener('pointerdown', dismiss); document.addEventListener('focusin', dismiss); window.addEventListener('resize', close);
    return () => {document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss); window.removeEventListener('resize', close);};
  }, [position]);
  const choose = (action: () => void) => {setPosition(null); action();};
  return <><button className="icon-button pane-create" ref={trigger} title="新标签页与分屏" aria-label="新标签页与分屏" aria-expanded={!!position} aria-haspopup="menu" onClick={() => {if(!position)setBusinessMenu(false);const r = trigger.current!.getBoundingClientRect(); setPosition(position ? null : {left: Math.max(8, Math.min(innerWidth - 216, r.left)), top: Math.max(8, Math.min(innerHeight - 345, r.bottom + 5))});}}><Plus size={16}/></button>{position && createPortal(<div className="backend-menu pane-menu" role="menu" aria-label="新建内容" ref={menu} style={{position: 'fixed', ...position, maxHeight: innerHeight-position.top-12, overflowY:'auto', zIndex: 1000}} onKeyDown={event => {
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); setPosition(null); trigger.current?.focus(); return;}
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]; const index = items.indexOf(document.activeElement as HTMLButtonElement); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();}
  }}>{businessMenu?<><button role="menuitem" onClick={()=>setBusinessMenu(false)}>‹ 返回</button><div className="pane-menu-label">业务组件</div><button role="menuitem" onClick={()=>choose(()=>onCreate('events'))}><Network size={15}/><span>工作区事件</span></button>{businessComponents.map(component=><button role="menuitem" key={component.id} onClick={()=>choose(()=>onCreate(`business:${component.id}`))}><Layers size={15}/><span>{component.title}</span></button>)}{!!integrations.length&&<div className="pane-menu-label">接入工具</div>}{integrations.flatMap(i=>i.surfaces.map(surface=><button role="menuitem" key={`${i.id}:${surface.id}`} onClick={()=>choose(()=>onCreate(`integration:${i.id}:${surface.id}`))}><Globe size={15}/><span>{surface.title||i.name}</span></button>))}</>:<><button role="menuitem" onClick={() => choose(() => onCreate('browser'))}><Globe size={15}/><span>浏览器</span></button><button role="menuitem" onClick={() => choose(() => onCreate('review'))}><FileCode2 size={15}/><span>文件审查</span></button><div className="pane-menu-label">Agent 会话</div>{Object.entries(agentNames).map(([id, name]) => <button key={id} role="menuitem" disabled={!!agents && !agents.backends.some(backend => backend.id === id && backend.available)} onClick={() => choose(() => onCreate(id as CreateKind))}><Terminal size={15}/><span>{name}</span><small>{agents ? agents.backends.some(backend => backend.id === id && backend.available) ? '本机' : '待接入' : '模拟'}</small></button>)}<div className="pane-menu-divider"/><button role="menuitem" onClick={()=>setBusinessMenu(true)}><Layers size={15}/><span>业务组件</span><small>›</small></button><div className="pane-menu-divider"/><button role="menuitem" disabled={!canSplit} onClick={() => choose(() => onSplit('row'))}><Columns2 size={15}/><span>向右分屏</span></button><button role="menuitem" disabled={!canSplit} onClick={() => choose(() => onSplit('column'))}><Rows2 size={15}/><span>向下分屏</span></button>{canMerge && <button role="menuitem" onClick={() => choose(onMerge)}><Layers size={15}/><span>合并所有分区</span></button>}</>}</div>, document.body)}</>;
}
