import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {ArrowLeft, Check, ChevronRight, Code2, Expand, FileText, Focus, Folder, Info, Layers, Lightbulb, MessageSquare, Minus, Plus, Redo2, ScanLine, Trash2, Undo2, X} from 'lucide-react';
import {isTask, placeNodes, taskChildren, type MindNode, type NodeKind} from './model';
import type {GraphState, Workspace} from './core';
import type {NodeDrop,NodeClipboard,NodeSelection} from './node-operations';

export interface MapCommands {
  canUndo:boolean;canRedo:boolean;error:string;undo:()=>void;redo:()=>void;
  sibling:(id:string)=>void;remove:(id:NodeSelection)=>void;move:(id:NodeSelection,targetId:string,position:NodeDrop)=>void;
  copy:(id:NodeSelection,cut?:boolean)=>NodeClipboard|null;paste:(id:string,text?:string,token?:string)=>string|null;failure:(message:string)=>void;
}
const typing=(target:EventTarget|null)=>target instanceof Element&&!!target.closest('input,textarea,[contenteditable="true"]');
function clipboardAccess<T>(action:Promise<T>):Promise<T>{return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('剪贴板访问超时')),1200);action.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});}

export const nodeKindNames: Record<NodeKind, string> = {root: '工作区', idea: '想法', analysis: '分析', event: '任务', document: '文档', code: '代码', artifact: '产物'};
export function NodeGlyph({kind, size = 18}: {kind: NodeKind; size?: number}) {
  const Icon = {root: Folder, idea: Lightbulb, analysis: ScanLine, event: Check, document: FileText, code: Code2, artifact: Layers}[kind];
  return <Icon size={size}/>;
}
export const placeWorkspaceNodes = (space: Workspace) => placeNodes(space.nodes.map(n => ({...n, side: 1 as const})), space.graph.collapsed, space.graph.focusId);
export function GraphView({space, onChange, onAdd, onRename, onInspect, autoEditId, sessionCounts,editing}: {space: Workspace; onChange: (graph: GraphState) => void; onAdd: (parentId: string) => void; onRename: (id: string, title: string) => void; onInspect: (id: string) => void; autoEditId?: string | null; sessionCounts: Record<string, number>;editing:MapCommands}) {
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{x: number; y: number; originX: number; originY: number} | null>(null);
  const [panning, setPanning] = useState(false);
  const [menu,setMenu]=useState<{id:string;x:number;y:number}|null>(null);
  const [drop,setDrop]=useState<{id:string;position:NodeDrop}|null>(null);
  const menuRef=useRef<HTMLDivElement>(null);
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const nodeDrag=useRef<{id:string;ids:string[];x:number;y:number;active:boolean}|null>(null);
  const [selection,setSelection]=useState<Set<string>>(new Set());
  const boxStart=useRef<{x:number;y:number}|null>(null);
  const [selectionBox,setSelectionBox]=useState<{x:number;y:number;width:number;height:number}|null>(null);
  useEffect(()=>{setSelection(old=>{const next=new Set([...old].filter(id=>space.nodes.some(n=>n.id===id)));return next.size===old.size?old:next;});},[space.nodes]);
  const nodeDrop=useRef<{id:string;position:NodeDrop}|null>(null);
  const skipClick=useRef(false);
  const [dragPreview,setDragPreview]=useState<{id:string;x:number;y:number}|null>(null);
  const graph = space.graph;
  const latest = useRef({graph, onChange}); latest.current = {graph, onChange};
  const positions = useMemo(() => placeWorkspaceNodes(space), [space.nodes, graph.collapsed, graph.focusId]);
  const camera = graph.camera || {x: 0, y: 0, zoom: 1};
  const activeNode=(target:EventTarget|null)=>target instanceof Element?target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId||menu?.id||graph.selectedId||positions[0]?.node.id:graph.selectedId||positions[0]?.node.id;
  const focusNode=(id:string|null)=>requestAnimationFrame(()=>{
    const viewport=frame.current;if(!viewport?.clientWidth||!viewport.clientHeight)return;
    const title=id&&viewport.querySelector<HTMLButtonElement>(`[data-node-id="${CSS.escape(id)}"] .map-node-title`);
    if(title){const node=title.closest('.graph-node')!.getBoundingClientRect(),view=viewport.getBoundingClientRect();const x=node.left<view.left+20?view.left+20-node.left:node.right>view.right-20?view.right-20-node.right:0;const y=node.top<view.top+20?view.top+20-node.top:node.bottom>view.bottom-55?view.bottom-55-node.bottom:0;if(x||y){const {graph,onChange}=latest.current;const camera=graph.camera||{x:0,y:0,zoom:1};onChange({...graph,camera:{...camera,x:camera.x+x,y:camera.y+y}});}title.focus({preventScroll:true});}else viewport.focus({preventScroll:true});
  });
  function remove(id:string){const ids=selection.has(id)&&selection.size>1?[...selection]:[id];const removable=ids.filter(id=>space.nodes.find(n=>n.id===id)?.parentId);if(!removable.length)return;const parent=space.nodes.find(n=>n.id===removable[0])?.parentId||null;editing.remove(removable);setSelection(new Set());setMenu(null);focusNode(parent);}
  function paste(id:string,text?:string,token?:string){const added=editing.paste(id,text,token);setMenu(null);focusNode(added||id);}
  const clipboardHtml=(clip:NodeClipboard)=>`<pre data-northstar-node-token="${clip.token}">${clip.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
  const clipboardToken=(html:string)=>html.match(/data-northstar-node-token="([a-z0-9-]+)"/i)?.[1];
  async function copy(id:string,cut=false){const clip=editing.copy(selection.has(id)&&selection.size>1?[...selection]:id,cut);setMenu(null);if(!clip)return;try{if(typeof ClipboardItem!=='undefined')await clipboardAccess(navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([clip.text],{type:'text/plain'}),'text/html':new Blob([clipboardHtml(clip)],{type:'text/html'})})]));else await clipboardAccess(navigator.clipboard.writeText(clip.text));}catch{editing.failure('系统剪贴板不可用，仍可在北极星内粘贴。');}if(cut)focusNode(space.nodes.find(n=>n.id===id)?.parentId||null);else focusNode(id);}
  async function pasteFromClipboard(id:string){setMenu(null);try{const items=await clipboardAccess(navigator.clipboard.read());if(!mounted.current)return;const item=items.find(item=>item.types.includes('text/plain'));if(item){const text=await (await item.getType('text/plain')).text();const html=item.types.includes('text/html')?await (await item.getType('text/html')).text():'';paste(id,text,clipboardToken(html));}else paste(id,await clipboardAccess(navigator.clipboard.readText()));}catch{if(!mounted.current)return;const added=editing.paste(id);focusNode(added||id);editing.failure(added?'无法访问系统剪贴板，已粘贴本窗口复制的分支。':'无法读取系统剪贴板，请按 Ctrl V 粘贴。');}}
  useEffect(()=>{if(!menu)return;menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();const close=(event:PointerEvent)=>{if(!menuRef.current?.contains(event.target as Node))setMenu(null);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[menu]);
  function fit() {
    if (!frame.current || !frame.current.clientWidth || !frame.current.clientHeight || !positions.length) return;
    const left = Math.min(...positions.map(p => p.x - p.width / 2));
    const right = Math.max(...positions.map(p => p.x + p.width / 2));
    const top = Math.min(...positions.map(p => p.y - p.height / 2));
    const bottom = Math.max(...positions.map(p => p.y + p.height / 2));
    const zoom = Math.max(.2, Math.min(1, (frame.current.clientWidth - 90) / (right - left), (frame.current.clientHeight - 100) / (bottom - top)));
    onChange({...graph, camera: {x: -(left + right) / 2 * zoom, y: -(top + bottom) / 2 * zoom, zoom}});
  }
  useLayoutEffect(() => {if (!graph.camera) fit();}, [graph.camera, graph.focusId, space.id]);
  const fitRef = useRef(fit); fitRef.current = fit;
  useEffect(() => {
    const element = frame.current!; let width = element.clientWidth; let height = element.clientHeight;
    const observer = new ResizeObserver(() => {if (!element.clientWidth || !element.clientHeight) return; if (!width || !height) {width = element.clientWidth; height = element.clientHeight; if (!latest.current.graph.camera) fitRef.current(); return;} if (Math.abs(width - element.clientWidth) > 25 || Math.abs(height - element.clientHeight) > 25) {width = element.clientWidth; height = element.clientHeight; fitRef.current();}});
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const viewport = frame.current!;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('textarea,input')) return;
      event.preventDefault();
      const {graph: current, onChange: change} = latest.current;
      const position = current.camera || {x: 0, y: 0, zoom: 1};
      change({...current, camera: event.ctrlKey || event.metaKey
        ? {...position, zoom: Math.max(.2, Math.min(2, position.zoom + (event.deltaY > 0 ? -.05 : .05)))}
        : {...position, x: position.x - event.deltaX, y: position.y - event.deltaY}});
    };
    viewport.addEventListener('wheel', wheel, {passive: false});
    return () => viewport.removeEventListener('wheel', wheel);
  }, []);
  function zoom(delta: number) {onChange({...graph, camera: {...camera, zoom: Math.max(.2, Math.min(2, Math.round((camera.zoom + delta) * 100) / 100))}});}
  return <div className={`graph-view workspace-graph ${panning ? 'panning' : ''}`} ref={frame} aria-label="工作区地图" data-map-workspace-id={space.id} tabIndex={0}
    onClickCapture={event=>{if(skipClick.current){event.preventDefault();event.stopPropagation();skipClick.current=false;return;}if(typing(event.target))return;const target=event.target as Element;const id=target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;if(id){if(event.ctrlKey||event.metaKey){event.preventDefault();event.stopPropagation();setSelection(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next;});focusNode(id);}else setSelection(new Set([id]));}else if(!target.closest('button,.graph-node-menu'))setSelection(new Set());}}
    onKeyDown={event=>{
      if(typing(event.target)||event.defaultPrevented||event.nativeEvent.isComposing||event.keyCode===229)return;
      const id=activeNode(event.target);if(!id)return;const command=event.ctrlKey||event.metaKey;const key=event.key.toLowerCase();
      if(command&&key==='a'){event.preventDefault();event.stopPropagation();setSelection(new Set(positions.map(p=>p.node.id)));return;}
      if(event.key==='Escape'&&selection.size){event.preventDefault();event.stopPropagation();setSelection(new Set());return;}
      if(command&&key==='z'){event.preventDefault();event.stopPropagation();event.shiftKey?editing.redo():editing.undo();focusNode(id);return;}
      if(command&&key==='y'){event.preventDefault();event.stopPropagation();editing.redo();focusNode(id);return;}
      if(event.altKey||command)return;
      if(['Delete','Backspace'].includes(event.key)){event.preventDefault();event.stopPropagation();remove(id);return;}
      if(event.key==='Tab'||event.key==='Insert'){event.preventDefault();event.stopPropagation();if(event.shiftKey)focusNode(space.nodes.find(n=>n.id===id)?.parentId||id);else onAdd(id);return;}
      if(event.key==='Enter'){event.preventDefault();event.stopPropagation();editing.sibling(id);return;}
      if(event.key==='F2'||event.key===' '){event.preventDefault();frame.current?.querySelector<HTMLButtonElement>(`[data-node-id="${CSS.escape(id)}"] .map-node-title`)?.click();return;}
      const node=space.nodes.find(n=>n.id===id);const siblings=space.nodes.filter(n=>n.parentId===node?.parentId);const index=siblings.findIndex(n=>n.id===id);
      const next=event.key==='ArrowLeft'?node?.parentId:event.key==='ArrowRight'?space.nodes.find(n=>n.parentId===id)?.id:event.key==='ArrowUp'?siblings[index-1]?.id:event.key==='ArrowDown'?siblings[index+1]?.id:undefined;
      if(event.key.startsWith('Arrow')){setSelection(new Set(next?[next]:[id]));event.preventDefault();event.stopPropagation();if(event.key==='ArrowRight'&&graph.collapsed.includes(id))onChange({...graph,collapsed:graph.collapsed.filter(value=>value!==id)});focusNode(next||id);}
    }}
    onCopy={event=>{if(typing(event.target))return;const id=activeNode(event.target);if(!id)return;const clip=editing.copy(selection.has(id)&&selection.size>1?[...selection]:id);if(clip){event.preventDefault();event.clipboardData.setData('text/plain',clip.text);event.clipboardData.setData('text/html',clipboardHtml(clip));}}}
    onCut={event=>{if(typing(event.target))return;const id=activeNode(event.target);if(!id)return;const clip=editing.copy(selection.has(id)&&selection.size>1?[...selection]:id,true);if(clip){event.preventDefault();event.clipboardData.setData('text/plain',clip.text);event.clipboardData.setData('text/html',clipboardHtml(clip));focusNode(space.nodes.find(n=>n.id===id)?.parentId||null);}}}
    onPaste={event=>{if(typing(event.target))return;const id=activeNode(event.target);if(id){event.preventDefault();paste(id,event.clipboardData.getData('text/plain'),clipboardToken(event.clipboardData.getData('text/html')));}}}
    onContextMenu={event=>{if(typing(event.target))return;const id=activeNode(event.target);if(!id)return;event.preventDefault();if(!selection.has(id))setSelection(new Set([id]));const rect=event.currentTarget.getBoundingClientRect();setMenu({id,x:Math.max(8,Math.min(event.clientX-rect.left,rect.width-230)),y:Math.max(8,Math.min(event.clientY-rect.top,rect.height-390))});}}
    onPointerDown={event => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button,input,textarea,.graph-node')) return;
      if(event.shiftKey){event.preventDefault();boxStart.current={x:event.clientX,y:event.clientY};event.currentTarget.setPointerCapture(event.pointerId);return;}
      drag.current = {x: event.clientX, y: event.clientY, originX: camera.x, originY: camera.y};
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const box=boxStart.current;
      if(box){const view=event.currentTarget.getBoundingClientRect();const x=Math.max(view.left,Math.min(box.x,event.clientX)),y=Math.max(view.top,Math.min(box.y,event.clientY)),right=Math.min(view.right,Math.max(box.x,event.clientX)),bottom=Math.min(view.bottom,Math.max(box.y,event.clientY));setSelectionBox({x:x-view.left,y:y-view.top,width:Math.max(0,right-x),height:Math.max(0,bottom-y)});setSelection(new Set([...event.currentTarget.querySelectorAll<HTMLElement>('[data-node-id]')].filter(element=>{const r=element.getBoundingClientRect();return r.left<right&&r.right>x&&r.top<bottom&&r.bottom>y;}).map(element=>element.dataset.nodeId!)));return;}
      const moving=nodeDrag.current;
      if(moving){
        if(!moving.active&&Math.hypot(event.clientX-moving.x,event.clientY-moving.y)<6)return;
        if(!moving.active){moving.active=true;event.currentTarget.setPointerCapture(event.pointerId);}
        const rect=event.currentTarget.getBoundingClientRect();setDragPreview({id:moving.id,x:event.clientX-rect.left+12,y:event.clientY-rect.top+12});
        const element=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-node-id]');
        if(element&&element.closest<HTMLElement>('[data-map-workspace-id]')===frame.current&&element.dataset.nodeId!==moving.id){const target=space.nodes.find(n=>n.id===element.dataset.nodeId);const r=element.getBoundingClientRect();const ratio=(event.clientY-r.top)/r.height;nodeDrop.current=target?{id:target.id,position:!target.parentId?'inside':ratio<.25?'before':ratio>.75?'after':'inside'}:null;}else nodeDrop.current=null;
        setDrop(nodeDrop.current);return;
      }
      const start = drag.current; if (!start) return; setPanning(true); onChange({...graph, camera: {...camera, x: start.originX + event.clientX - start.x, y: start.originY + event.clientY - start.y}});
    }}
    onPointerUp={event=>{if(boxStart.current||drag.current&&Math.hypot(event.clientX-drag.current.x,event.clientY-drag.current.y)>3){skipClick.current=true;setTimeout(()=>{skipClick.current=false;},0);}boxStart.current=null;setSelectionBox(null);const moving=nodeDrag.current;if(moving?.active){const target=nodeDrop.current;if(target)editing.move(moving.ids,target.id,target.position);event.preventDefault();skipClick.current=true;setTimeout(()=>{skipClick.current=false;},0);focusNode(moving.id);}nodeDrag.current=null;nodeDrop.current=null;setDrop(null);setDragPreview(null);drag.current=null;setPanning(false);}}
    onPointerCancel={()=>{boxStart.current=null;setSelectionBox(null);nodeDrag.current=null;nodeDrop.current=null;setDrop(null);setDragPreview(null);drag.current=null;setPanning(false);}}>
    {graph.focusId && <button className="graph-return text-button" onClick={() => onChange({...graph, focusId: null, camera: null})}><ArrowLeft size={14}/>返回全图</button>}
    <div className="graph-content" style={{transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`}}>
      <svg className="graph-edges" aria-hidden="true">{positions.slice(1).map(item => {
        const parent = positions.find(p => p.node.id === item.node.parentId);
        if (!parent) return null;
        const side = item.x > parent.x ? 1 : -1;
        const x1 = parent.x + parent.width / 2 * side;
        const x2 = item.x - item.width / 2 * side;
        const middle = (x1 + x2) / 2;
        return <path key={item.node.id} d={`M${x1},${parent.y} C${middle},${parent.y} ${middle},${item.y} ${x2},${item.y}`}/>;
      })}</svg>
      {positions.map(({node, x, y, width, height}, index) => {
        const count = sessionCounts[node.id] || 0;
        const children = space.nodes.some(n => n.parentId === node.id);
        return <div key={node.id} data-node-id={node.id} draggable={false} className={`graph-node kind-${node.kind} ${index === 0 ? 'root-node' : ''} ${graph.selectedId === node.id ? 'selected' : ''} ${selection.has(node.id)?'multi-selected':''} ${drop?.id===node.id?'node-drop-'+drop.position:''} ${dragPreview?.id===node.id?'node-being-dragged':''}`} style={{left: x - width / 2, top: y - height / 2, width, minHeight: height}}
          onDragStart={event=>{if(!typing(event.target))event.preventDefault();}}
          onPointerDown={event=>{if(event.button===0&&node.parentId&&!typing(event.target)){nodeDrag.current={id:node.id,ids:selection.has(node.id)?[...selection]:[node.id],x:event.clientX,y:event.clientY,active:false};}}}>
          <MapNodeContent node={node} count={count} autoEdit={autoEditId === node.id} onRename={title => onRename(node.id, title)} onInspect={() => onInspect(node.id)} onChild={()=>onAdd(node.id)}/>
          <button className="graph-node-details" aria-label={`查看${node.title}详情`} title="查看内容、材料与会话" onClick={() => onInspect(node.id)}><Info size={13}/></button>
          <button className="graph-node-add" aria-label={`在${node.title}下添加节点`} onClick={() => onAdd(node.id)}><Plus size={13}/></button>
          {children && <button className="graph-node-collapse" aria-label={`${graph.collapsed.includes(node.id) ? '展开' : '收起'}${node.title}分支`} onClick={() => onChange({...graph, collapsed: graph.collapsed.includes(node.id) ? graph.collapsed.filter(id => id !== node.id) : [...graph.collapsed, node.id]})}>{graph.collapsed.includes(node.id) ? '+' : '−'}</button>}
        </div>;
      })}
    </div>
    {selectionBox&&<div className="graph-selection-box" style={{left:selectionBox.x,top:selectionBox.y,width:selectionBox.width,height:selectionBox.height}}/>}
    {dragPreview&&<span className="node-drag-preview" style={{left:dragPreview.x,top:dragPreview.y}}>{space.nodes.find(n=>n.id===dragPreview.id)?.title}</span>}
    <span className={`graph-hint ${editing.error?'graph-edit-error':''}`} role="status">{editing.error||(selection.size>1?`已选 ${selection.size} 个节点 · Delete 删除 · Ctrl C 复制 · Esc 取消`:'点标题改名 · 右键节点操作 · Delete 删除 · Ctrl Z 撤销')}</span>
    {menu&&<div ref={menuRef} className="graph-node-menu" role="menu" aria-label="节点操作" style={{left:menu.x,top:menu.y}} onKeyDown={event=>{if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(event.key==='Escape'){event.preventDefault();setMenu(null);focusNode(menu.id);}event.stopPropagation();}}>
      <button role="menuitem" onClick={()=>{setMenu(null);onAdd(menu.id);}}>添加子节点<kbd>Tab</kbd></button>
      <button role="menuitem" disabled={!space.nodes.find(n=>n.id===menu.id)?.parentId} onClick={()=>{setMenu(null);editing.sibling(menu.id);}}>添加同级节点<kbd>Enter</kbd></button>
      <button role="menuitem" onClick={()=>{setMenu(null);frame.current?.querySelector<HTMLButtonElement>(`[data-node-id="${CSS.escape(menu.id)}"] .map-node-title`)?.click();}}>修改标题<kbd>F2</kbd></button>
      <button role="menuitem" onClick={()=>void copy(menu.id)}>复制分支<kbd>Ctrl C</kbd></button>
      <button role="menuitem" disabled={!space.nodes.some(n=>(selection.has(menu.id)?selection.has(n.id):n.id===menu.id)&&n.parentId)} onClick={()=>void copy(menu.id,true)}>剪切分支<kbd>Ctrl X</kbd></button>
      <button role="menuitem" onClick={()=>{void pasteFromClipboard(menu.id);}}>粘贴为子节点<kbd>Ctrl V</kbd></button>
      <button role="menuitem" onClick={()=>{onChange({...graph,collapsed:graph.collapsed.includes(menu.id)?graph.collapsed.filter(id=>id!==menu.id):[...graph.collapsed,menu.id]});setMenu(null);focusNode(menu.id);}}>{graph.collapsed.includes(menu.id)?'展开分支':'收起分支'}</button>
      <button role="menuitem" className="node-delete-action" disabled={!space.nodes.some(n=>(selection.has(menu.id)?selection.has(n.id):n.id===menu.id)&&n.parentId)} onClick={()=>remove(menu.id)}>删除节点及子节点<kbd>Delete</kbd></button>
    </div>}
    <div className="graph-tools"><button className="icon-button" aria-label="撤销地图操作" title="撤销 Ctrl Z" disabled={!editing.canUndo} onClick={()=>{editing.undo();frame.current?.focus();}}><Undo2 size={15}/></button><button className="icon-button" aria-label="重做地图操作" title="重做 Ctrl Y" disabled={!editing.canRedo} onClick={()=>{editing.redo();frame.current?.focus();}}><Redo2 size={15}/></button><button className="text-button" onClick={() => onChange({...graph, collapsed: graph.collapsed.length ? [] : [space.nodes.find(n => !n.parentId)!.id], camera: null})}><ScanLine size={14}/>归一</button><button className="icon-button" aria-label="适合画布" onClick={fit}><Expand size={15}/></button><span className="zoom-controls"><button className="icon-button" aria-label="缩小画布" onClick={() => zoom(-.1)}><Minus size={14}/></button><button aria-label="恢复百分之百" onClick={() => onChange({...graph, camera: {...camera, zoom: 1}})}>{Math.round(camera.zoom * 100)}%</button><button className="icon-button" aria-label="放大画布" onClick={() => zoom(.1)}><Plus size={14}/></button></span></div>
  </div>;
}

function MapNodeContent({node, count, autoEdit, onRename, onInspect, onChild}: {node: MindNode; count: number; autoEdit: boolean; onRename: (title: string) => void; onInspect: () => void; onChild:()=>void}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(node.title);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  const returnFocus = useRef(false);
  const draft = useRef({title, onRename}); draft.current = {title, onRename};
  useEffect(() => () => {if (active.current) draft.current.onRename(draft.current.title);}, []);
  function begin() {active.current = true; setTitle(node.title); setEditing(true);}
  function finish(save: boolean, focus = false) {
    if (!active.current) return;
    active.current = false; returnFocus.current = focus;
    if (save) onRename(title);
    setEditing(false);
  }
  useEffect(() => {if (autoEdit) begin();}, [autoEdit]);
  useLayoutEffect(() => {
    if (editing) {input.current?.focus(); input.current?.select();}
    else if (returnFocus.current) {returnFocus.current = false; button.current?.focus();}
  }, [editing]);
  const content = <>
    <span className="map-node-heading"><NodeGlyph kind={isTask(node) ? 'event' : node.kind}/>{editing ? <input ref={input} className="map-node-input" aria-label="节点标题" maxLength={120} value={title} onClick={event=>event.stopPropagation()} onChange={event => setTitle(event.target.value)} onBlur={() => finish(true)} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === 'Escape') event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if(event.key==='Tab'&&!event.shiftKey){event.preventDefault();event.stopPropagation();finish(true);onChild();return;}
      if (event.key === 'Enter' || event.key === 'Escape') {event.preventDefault(); finish(event.key === 'Enter', true);}
    }}/> : <button ref={button} className="map-node-title" aria-label={`编辑${node.title}标题`} title="点击修改标题" onClick={event=>{event.stopPropagation();begin();}} onKeyDown={event=>{if(event.key==='F2'){event.preventDefault();begin();}}}><strong>{node.title}</strong></button>}</span>
    {!!count && <button className="node-session-count" onClick={event => {event.stopPropagation(); onInspect();}}><MessageSquare size={12}/>关联会话 {count}<ChevronRight size={12}/></button>}
  </>;
  return <div className={`graph-node-content ${editing ? 'editing' : ''}`} tabIndex={0} onClick={event=>{onInspect();if(!editing)event.currentTarget.focus();}} >{content}</div>;
}

export function NodeOverview({space, node, onDue, onOpen, onAdd}: {space: Workspace; node: MindNode; onDue: (value: string) => void; onOpen: (id: string) => void; onAdd: () => void}) {
  const tasks = taskChildren(space.nodes, node.id);
  return <section className="node-task-capability">{isTask(node) && <>
    <label className="field">计划完成<input aria-label="计划完成日期" type="date" value={node.due} onChange={event => onDue(event.target.value)}/></label>
  </>}
    <div className="detail-section-heading"><h3>子任务（{tasks.length}）</h3><button className="text-button" disabled={space.nodes.length >= 250} onClick={onAdd}><Plus size={13}/>添加子任务</button></div>
    <div className="node-subtasks">{tasks.map(task => <div key={task.id}><button className="text-button" onClick={() => onOpen(task.id)}>{task.title}<ChevronRight size={12}/></button></div>)}</div>
  </section>;
}

export function NodeInspector({space, node, onEditBody, onClose, onFocus, onDelete, children}: {space: Workspace; node: MindNode; onEditBody: (value: string) => void; onClose: () => void; onFocus: () => void; onDelete?:()=>void; children: React.ReactNode}) {
  const content = node.body;
  const [value, setValue] = useState(content); const [focused, setFocused] = useState(false);
  const original = useRef(content); const cancelled = useRef(false);
  useEffect(() => {if (!focused) setValue(content);}, [content, focused]);
  return <aside className="node-inspector" aria-label="节点详情"><div className="inspector-meta"><span>{isTask(node) ? '任务' : '节点'} / {space.name}</span><div className="inspector-node-actions">{node.parentId&&onDelete&&<button className="icon-button" aria-label="删除节点及子节点" title="删除节点及子节点，可撤销" onClick={event=>{event.currentTarget.closest('.workspace-map-scene')?.querySelector<HTMLDivElement>('.graph-view')?.focus();onDelete();}}><Trash2 size={15}/></button>}<button className="icon-button" aria-label="关闭节点详情" onClick={onClose}><X size={16}/></button></div></div><h2 className="node-detail-title">{node.title}</h2><textarea className="node-body-editor" aria-label="节点正文" placeholder="记录节点内容…" value={value} rows={7} onFocus={() => {original.current = content;setFocused(true);}} onChange={event => {setValue(event.target.value);onEditBody(event.target.value);}} onBlur={() => {if (!cancelled.current) onEditBody(value);cancelled.current = false;setFocused(false);}} onKeyDown={event => {if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229) {event.preventDefault();event.stopPropagation();cancelled.current = true;setValue(original.current);onEditBody(original.current);event.currentTarget.blur();}}}/>{children}<div className="inspector-footer"><button className="text-button" onClick={onFocus}><Focus size={14}/>聚焦此分支</button><span><Check size={12}/>自动保存</span></div></aside>;
}

export function TasksView({space, onOpen}: {space: Workspace; onOpen: (nodeId: string) => void}) {
  const tasks = space.nodes.filter(isTask);
  return <div className="content-page"><div className="page-heading"><h2>任务</h2><span className="muted">与图谱使用同一条记录</span></div>{tasks.map(node => <button className="task-row" key={node.id} onClick={() => onOpen(node.id)}><Lightbulb size={16}/><span><strong>{node.title}</strong><small>{node.body || ''}</small></span><ChevronRight size={15}/></button>)}{!tasks.length && <p className="muted">在节点信息中添加子任务。</p>}</div>;
}
