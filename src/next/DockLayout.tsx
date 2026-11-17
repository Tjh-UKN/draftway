import {useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Columns2, FileCode2, Globe, GripVertical, Layers, MessageSquare, Network, Plus, Rows2, Terminal, X} from 'lucide-react';
import {latestRun, statusNames, type AgentSession, type WorkbenchState, type Workspace} from './core';
import {closeEmptyGroup, groups, mergeDock, moveDockGroup, moveDockTab, resizeDock, splitDockGroup, type DockNode, type DockState, type DockTab, type Split, type TabGroup} from './docking';
import {canDockDrop,dockEdge,type DockDragItem,type DockDrop} from './dock-drag';
import {agentNames} from './integrations';
import {useAgentRuntime} from './NativeAgents';
import {businessComponents,type BusinessPage} from '../business-components';
import type {ExternalIntegration} from './integration-manifest';

type CreateKind = 'map' | 'browser' | 'review' | 'events' | NonNullable<AgentSession['agentId']> | `business:${BusinessPage}` | `integration:${string}`;
interface Props {
  state: WorkbenchState; space: Workspace;
  onChange: (update: (dock: DockState) => DockState) => void;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onCreate: (kind: CreateKind, groupId: string) => void;
  render: (tab: DockTab, active: boolean,visible:boolean) => ReactNode;
}
interface DragGesture {item:DockDragItem;x:number;y:number;pointerId:number;active:boolean;}
export function DockLayout(props: Props) {
  const frame=useRef<HTMLDivElement>(null),ghost=useRef<HTMLDivElement>(null);
  const candidate=useRef<DragGesture|null>(null),cancelled=useRef<number|null>(null),skipClick=useRef(false);
  const current=useRef(props);current.current=props;
  const [drag,setDrag]=useState<{item:DockDragItem;drop:DockDrop|null}|null>(null);
  const [slots,setSlots]=useState<Record<string,{left:number;top:number;width:number;height:number}>>({});
  useLayoutEffect(()=>{
    const element=frame.current!;const measure=()=>{
      const origin=element.getBoundingClientRect();const next:typeof slots={};
      for(const slot of element.querySelectorAll<HTMLElement>('.dock-group-content')){const owner=slot.closest<HTMLElement>('.dock-group')!;const rect=slot.getBoundingClientRect();next[owner.dataset.groupId!]={left:rect.left-origin.left,top:rect.top-origin.top,width:rect.width,height:rect.height};}
      setSlots(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);
    };
    const observer=new ResizeObserver(measure);observer.observe(element);for(const slot of element.querySelectorAll('.dock-group-content'))observer.observe(slot);measure();return()=>observer.disconnect();
  },[props.space.dock.root]);
  function cancel(){candidate.current=null;setDrag(null);document.body.classList.remove('dragging-dock');}
  useEffect(()=>{
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&candidate.current?.active){event.preventDefault();event.stopPropagation();cancelled.current=candidate.current.pointerId;cancel();}};
    const blur=()=>{cancelled.current=null;cancel();};
    window.addEventListener('keydown',escape,true);window.addEventListener('blur',blur);
    return()=>{window.removeEventListener('keydown',escape,true);window.removeEventListener('blur',blur);document.body.classList.remove('dragging-dock');};
  },[]);
  function targetAt(x:number,y:number,item:DockDragItem):DockDrop|null {
    const hit=document.elementFromPoint(x,y);let group=hit?.closest<HTMLElement>('.dock-group[data-group-id]');
    if(!group){const owner=hit?.closest<HTMLElement>('[data-dock-scene-group]')?.dataset.dockSceneGroup;if(owner)group=frame.current?.querySelector<HTMLElement>(`.dock-group[data-group-id="${CSS.escape(owner)}"]`);}
    if(!group||!frame.current?.contains(group))return null;
    const dock=current.current.space.dock,groupId=group.dataset.groupId!;
    const header=group.querySelector<HTMLElement>('.dock-group-header')!,headerRect=header.getBoundingClientRect();
    let drop:DockDrop;
    if(y<headerRect.bottom&&item.kind==='tab'){
      const tabs=[...group.querySelectorAll<HTMLElement>('[data-dock-tab-id]')];
      const before=tabs.find(tab=>{const rect=tab.getBoundingClientRect();return x<rect.left+rect.width/2;});
      const last=tabs.at(-1)?.getBoundingClientRect();
      const marker=Math.max(headerRect.left+16,Math.min(headerRect.right-34,before?.getBoundingClientRect().left||last?.right||headerRect.left+16));
      drop={groupId,beforeId:before?.dataset.dockTabId,marker:{x:marker,y:headerRect.top+7,height:headerRect.height-14}};
    }else{
      const body=group.querySelector<HTMLElement>('.dock-group-content')!.getBoundingClientRect();
      drop={groupId,edge:y<headerRect.bottom?undefined:dockEdge(body,x,y),rect:{left:body.left,top:body.top,width:body.width,height:body.height}};
    }
    return canDockDrop(dock,item,drop)?drop:null;
  }
  function tree(node: DockNode): ReactNode {
    if (node.kind === 'split') return <SplitView key={node.id} node={node} onResize={ratio => props.onChange(dock => resizeDock(dock, node.id, ratio))}>{tree(node.children[0])}{tree(node.children[1])}</SplitView>;
    return <GroupView key={node.id} {...props} group={node} dragging={!!drag}/>;
  }
  const preview=drag?.drop?.rect;
  const edge=drag?.drop?.edge;
  const previewStyle=preview?{position:'fixed' as const,inset:'auto',left:preview.left+8+(edge==='right'?preview.width/2:0),top:preview.top+8+(edge==='bottom'?preview.height/2:0),width:preview.width/(edge==='left'||edge==='right'?2:1)-16,height:preview.height/(edge==='top'||edge==='bottom'?2:1)-16}:undefined;
  const owners=groups(props.space.dock.root);
  function focusScene(groupId:string){if(current.current.space.dock.activeGroupId!==groupId&&!candidate.current?.active)current.current.onChange(dock=>({...dock,activeGroupId:groupId}));}
  return <div className={`dock-layout ${drag?'is-dragging':''}`} ref={frame}
    onPointerDownCapture={event=>{
      if(event.button!==0)return;const element=event.target as Element;
      if(element.closest('input,textarea,[contenteditable=true],.dock-tab-close,.pane-create,.dock-divider'))return;
      const tab=element.closest<HTMLElement>('[data-dock-tab-id]');const header=element.closest<HTMLElement>('.dock-group-header');
      const group=header?.closest<HTMLElement>('[data-group-id]');if(!header||!group)return;
      let item:DockDragItem;
      if(tab)item={kind:'tab',id:tab.dataset.dockTabId!,label:tab.querySelector('[role=tab]')?.getAttribute('aria-label')||'页签'};
      else{if(element.closest('button')||!groups(current.current.space.dock.root).find(g=>g.id===group.dataset.groupId)?.tabs.length)return;item={kind:'group',id:group.dataset.groupId!,label:group.getAttribute('aria-label')?.replace('分区：','')||'分区'};}
      candidate.current={item,x:event.clientX,y:event.clientY,pointerId:event.pointerId,active:false};cancelled.current=null;
    }}
    onDragStart={event=>{if((event.target as Element).closest('.dock-group-header'))event.preventDefault();}}
    onPointerMove={event=>{
      const source=candidate.current;if(!source)return;
      if(!source.active){if(Math.hypot(event.clientX-source.x,event.clientY-source.y)<6)return;source.active=true;event.currentTarget.setPointerCapture(event.pointerId);document.body.classList.add('dragging-dock');}
      event.preventDefault();source.x=event.clientX;source.y=event.clientY;
      const drop=targetAt(event.clientX,event.clientY,source.item);
      setDrag(old=>old&&JSON.stringify(old.drop)===JSON.stringify(drop)?old:{item:source.item,drop});
      if(ghost.current){ghost.current.style.left=Math.min(innerWidth-250,event.clientX+16)+'px';ghost.current.style.top=event.clientY+14+'px';}
    }}
    onPointerUp={event=>{
      const source=candidate.current;const wasCancelled=cancelled.current===event.pointerId;cancelled.current=null;
      if(!source?.active&&!wasCancelled){candidate.current=null;return;}
      event.preventDefault();skipClick.current=true;setTimeout(()=>skipClick.current=false,0);
      const target=source?.active?targetAt(event.clientX,event.clientY,source.item):null;
      if(source&&target){const item=source.item,placementId=crypto.randomUUID();current.current.onChange(dock=>item.kind==='tab'?moveDockTab(dock,item.id,target.groupId,target.beforeId,target.edge,placementId):moveDockGroup(dock,item.id,target.groupId,target.edge,placementId));}
      cancel();if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={()=>{cancelled.current=null;cancel();}}
    onLostPointerCapture={()=>{if(candidate.current?.active)cancel();}}
    onClickCapture={event=>{if(skipClick.current){event.preventDefault();event.stopPropagation();skipClick.current=false;}}}>
    {tree(props.space.dock.root)}
    {/* Keep tab surfaces outside the split tree so pane moves do not remount editors or iframes. */}
    <div className="dock-scene-layer">{props.space.dock.tabs.map(tab=>{
      const owner=owners.find(g=>g.tabs.includes(tab.id))!;const rect=slots[owner.id];const selected=owner.activeId===tab.id;
      return <div key={tab.id} className={`dock-scene scene-${tab.kind}`} data-dock-scene-group={owner.id} role="tabpanel" id={`dock-panel-${props.space.id}-${tab.id}`} aria-labelledby={`dock-tab-${props.space.id}-${tab.id}`} hidden={!selected||!rect} style={rect} onPointerDownCapture={()=>focusScene(owner.id)} onFocusCapture={()=>focusScene(owner.id)}>{props.render(tab,selected&&props.space.dock.activeGroupId===owner.id,selected)}</div>;
    })}</div>
    {previewStyle&&<div className="dock-drop-preview" style={previewStyle}><span>{edge?{left:'放到左侧',right:'放到右侧',top:'放到上方',bottom:'放到下方'}[edge]:'合并到此分区'}</span></div>}
    {drag&&<div ref={ghost} className="dock-drag-ghost" style={{left:Math.min(innerWidth-250,(candidate.current?.x||0)+16),top:(candidate.current?.y||0)+14}}>{drag.item.kind==='group'&&<GripVertical size={13}/>}<span>{drag.item.label}</span></div>}
    {drag?.drop?.marker&&<span className="dock-tab-insertion" style={{left:drag.drop.marker.x,top:drag.drop.marker.y,height:drag.drop.marker.height}}/>}
  </div>;
}
function SplitView({node, children, onResize}: {node: Split; children: ReactNode[]; onResize: (ratio: number) => void}) {
  const container = useRef<HTMLDivElement>(null);const resizing=useRef(false);useEffect(()=>()=>{if(resizing.current)document.body.classList.remove('resizing-panes');},[]);
  return <div ref={container} className={`dock-split split-${node.axis}`} style={{gridTemplateColumns: node.axis === 'row' ? `minmax(0, ${node.ratio}fr) 5px minmax(0, ${1 - node.ratio}fr)` : undefined, gridTemplateRows: node.axis === 'column' ? `minmax(0, ${node.ratio}fr) 5px minmax(0, ${1 - node.ratio}fr)` : undefined}}>
    {children[0]}<div className="dock-divider" role="separator" aria-label={node.axis === 'row' ? '调整左右分区大小' : '调整上下分区大小'} aria-orientation={node.axis === 'row' ? 'vertical' : 'horizontal'} aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(node.ratio * 100)} tabIndex={0} onKeyDown={event => {if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {event.preventDefault(); onResize(node.ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -.025 : .025));}}} onPointerDown={event => {
      event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);resizing.current=true;document.body.classList.add('resizing-panes');
    }} onPointerMove={event => {if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const rect = container.current!.getBoundingClientRect(); onResize(node.axis === 'row' ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height);}} onPointerUp={event => {event.currentTarget.releasePointerCapture(event.pointerId); document.body.classList.remove('resizing-panes');}} onLostPointerCapture={() => {resizing.current=false;document.body.classList.remove('resizing-panes');}}/>{children[1]}
  </div>;
}
function GroupView({group, dragging, ...props}: Props & {group: TabGroup; dragging: boolean}) {
  const {state, space, onChange, onSelect, onClose, onCreate} = props;
  const focused = space.dock.activeGroupId === group.id;
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'nearest', inline: 'nearest'});}, [group.activeId]);
  function focus() {if (!focused&&!dragging) onChange(dock => ({...dock, activeGroupId: group.id}));}
  return <section className={`dock-group ${focused ? 'focused' : ''}`} aria-label={`分区：${space.dock.tabs.find(t => t.id === group.activeId)?.title || '新分区'}`} data-group-id={group.id} aria-owns={group.tabs.map(id=>`dock-panel-${space.id}-${id}`).join(' ')} onPointerDownCapture={focus} onFocusCapture={focus}>
    <header className="dock-group-header"><span className="dock-pane-handle" title="拖动整个分区" aria-hidden="true"><GripVertical size={13}/></span><div className="dock-tab-strip" role="tablist" aria-label="分区页签" ref={strip} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]; const at = tabs.indexOf(document.activeElement as HTMLButtonElement); if (at < 0) return;
      event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[index].focus(); tabs[index].click();
    }}>
      {group.tabs.map(id => {
        const tab = space.dock.tabs.find(t => t.id === id)!; const session = tab.kind === 'session' ? state.sessions.find(s => s.id === tab.sessionId) : undefined;
        const provider = session ? agentNames[session.agentId || 'codex'] : '';
        const title = session ? session.title : tab.title; const label = provider ? `${provider}：${title}` : title;
        const status = session ? latestRun(state, session.id)?.state || 'idle' : null;
        const active = group.activeId === id;
        return <div key={id} className={`dock-tab ${active ? 'active' : ''}`} draggable={false} data-dock-tab-id={id}>
          <button role="tab" id={`dock-tab-${space.id}-${id}`} aria-selected={active} aria-controls={`dock-panel-${space.id}-${id}`} tabIndex={active ? 0 : -1} aria-label={label} title={`${label}${status ? ` · ${statusNames[status]}` : ''}`} onClick={() => onSelect(id)} onAuxClick={event => {if (event.button === 1 && tab.id !== 'workspace') {event.preventDefault(); onClose(id);}}}>
            {tab.kind === 'map' ? <Network size={14}/> : tab.kind === 'browser' ? <Globe size={14}/> : ['review', 'report'].includes(tab.kind) ? <FileCode2 size={14}/> : session?.agentId === 'codex' ? <Terminal size={14}/> : <MessageSquare size={14}/>}
            <span>{title}</span>{status && <i className={`tab-run-indicator run-${status} ${session?.unread ? 'has-unread' : ''}`} aria-label={session?.unread ? '未读结果' : statusNames[status]}/>}
          </button>{tab.id !== 'workspace' && <button className="dock-tab-close" aria-label={`关闭${label}页签`} title={tab.kind === 'session' ? '关闭页签，保留会话记录' : '关闭页签'} onClick={() => onClose(id)}><X size={11}/></button>}
        </div>;
      })}
    </div><PaneMenu integrations={state.externalIntegrations||[]} onCreate={kind => onCreate(kind, group.id)} onSplit={axis => onChange(dock => splitDockGroup(dock, group.id, axis))} onMerge={() => onChange(mergeDock)} canSplit={groups(space.dock.root).length < 8} canMerge={space.dock.root.kind === 'split'}/>{!group.tabs.length && <button className="icon-button" aria-label="关闭空分区" onClick={() => onChange(dock => closeEmptyGroup(dock, group.id))}><X size={13}/></button>}</header>
    <div className="dock-group-content">
      {!group.tabs.length && <div className="tool-empty"><p>从上方“＋”打开内容</p></div>}
      {dragging && <div className="dock-drop-capture"/>}
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
  }}>{businessMenu?<><button role="menuitem" onClick={()=>setBusinessMenu(false)}>‹ 返回</button><div className="pane-menu-label">业务组件</div><button role="menuitem" onClick={()=>choose(()=>onCreate('events'))}><Network size={15}/><span>工作区事件</span></button>{businessComponents.map(component=><button role="menuitem" key={component.id} onClick={()=>choose(()=>onCreate(`business:${component.id}`))}><Layers size={15}/><span>{component.title}</span></button>)}{!!integrations.length&&<div className="pane-menu-label">接入工具</div>}{integrations.flatMap(i=>i.surfaces.map(surface=><button role="menuitem" key={`${i.id}:${surface.id}`} onClick={()=>choose(()=>onCreate(`integration:${i.id}:${surface.id}`))}><Globe size={15}/><span>{surface.title||i.name}</span></button>))}</>:<><button role="menuitem" onClick={() => choose(() => onCreate('map'))}><Network size={15}/><span>思维导图</span></button><button role="menuitem" onClick={() => choose(() => onCreate('browser'))}><Globe size={15}/><span>浏览器</span></button><button role="menuitem" onClick={() => choose(() => onCreate('review'))}><FileCode2 size={15}/><span>文件审查</span></button><div className="pane-menu-label">Agent 会话</div>{Object.entries(agentNames).map(([id, name]) => <button key={id} role="menuitem" disabled={!!agents && !agents.backends.some(backend => backend.id === id && backend.available)} onClick={() => choose(() => onCreate(id as CreateKind))}><Terminal size={15}/><span>{name}</span><small>{agents ? agents.backends.some(backend => backend.id === id && backend.available) ? '本机' : '待接入' : '模拟'}</small></button>)}<div className="pane-menu-divider"/><button role="menuitem" onClick={()=>setBusinessMenu(true)}><Layers size={15}/><span>业务组件</span><small>›</small></button><div className="pane-menu-divider"/><button role="menuitem" disabled={!canSplit} onClick={() => choose(() => onSplit('row'))}><Columns2 size={15}/><span>向右分屏</span></button><button role="menuitem" disabled={!canSplit} onClick={() => choose(() => onSplit('column'))}><Rows2 size={15}/><span>向下分屏</span></button>{canMerge && <button role="menuitem" onClick={() => choose(onMerge)}><Layers size={15}/><span>合并所有分区</span></button>}</>}</div>, document.body)}</>;
}
