import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {ArrowLeft, Check, ChevronRight, Code2, Expand, FileText, Focus, Folder, Info, Layers, Lightbulb, MessageSquare, Minus, Plus, ScanLine, X} from 'lucide-react';
import {isTask, nodeProgress, placeNodes, taskChildren, type MindNode, type NodeKind} from './model';
import type {GraphState, Workspace} from './core';

export const nodeKindNames: Record<NodeKind, string> = {root: '工作区', idea: '想法', analysis: '分析', event: '任务', document: '文档', code: '代码', artifact: '产物'};
export function NodeGlyph({kind, size = 18}: {kind: NodeKind; size?: number}) {
  const Icon = {root: Folder, idea: Lightbulb, analysis: ScanLine, event: Check, document: FileText, code: Code2, artifact: Layers}[kind];
  return <Icon size={size}/>;
}
export const placeWorkspaceNodes = (space: Workspace) => placeNodes(space.nodes.map(n => ({...n, side: 1 as const})), space.graph.collapsed, space.graph.focusId);
export function GraphView({space, onChange, onAdd, onRename, onInspect, autoEditId, sessionCounts}: {space: Workspace; onChange: (graph: GraphState) => void; onAdd: (parentId: string) => void; onRename: (id: string, title: string) => void; onInspect: (id: string) => void; autoEditId?: string | null; sessionCounts: Record<string, number>}) {
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{x: number; y: number; originX: number; originY: number} | null>(null);
  const [panning, setPanning] = useState(false);
  const graph = space.graph;
  const latest = useRef({graph, onChange}); latest.current = {graph, onChange};
  const positions = useMemo(() => placeWorkspaceNodes(space), [space.nodes, graph.collapsed, graph.focusId]);
  const camera = graph.camera || {x: 0, y: 0, zoom: 1};
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
  return <div className={`graph-view workspace-graph ${panning ? 'panning' : ''}`} ref={frame} aria-label="工作区地图"
    onPointerDown={event => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button,input,textarea,.graph-node')) return;
      drag.current = {x: event.clientX, y: event.clientY, originX: camera.x, originY: camera.y};
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {const start = drag.current; if (!start) return; setPanning(true); onChange({...graph, camera: {...camera, x: start.originX + event.clientX - start.x, y: start.originY + event.clientY - start.y}});}}
    onPointerUp={() => {drag.current = null; setPanning(false);}} onPointerCancel={() => {drag.current = null; setPanning(false);}}>
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
        const progress = nodeProgress(space.nodes, node.id);
        const count = sessionCounts[node.id] || 0;
        const children = space.nodes.some(n => n.parentId === node.id);
        return <div key={node.id} className={`graph-node kind-${node.kind} ${index === 0 ? 'root-node' : ''} ${graph.selectedId === node.id ? 'selected' : ''}`} style={{left: x - width / 2, top: y - height / 2, width, minHeight: height}}>
          <MapNodeContent node={node} progress={progress} count={count} autoEdit={autoEditId === node.id} onRename={title => onRename(node.id, title)} onInspect={() => onInspect(node.id)}/>
          <button className="graph-node-details" aria-label={`查看${node.title}详情`} title="查看内容、材料、会话与进度" onClick={() => onInspect(node.id)}><Info size={13}/></button>
          <button className="graph-node-add" aria-label={`在${node.title}下添加节点`} onClick={() => onAdd(node.id)}><Plus size={13}/></button>
          {children && <button className="graph-node-collapse" aria-label={`${graph.collapsed.includes(node.id) ? '展开' : '收起'}${node.title}分支`} onClick={() => onChange({...graph, collapsed: graph.collapsed.includes(node.id) ? graph.collapsed.filter(id => id !== node.id) : [...graph.collapsed, node.id]})}>{graph.collapsed.includes(node.id) ? '+' : '−'}</button>}
        </div>;
      })}
    </div>
    <span className="graph-hint">点标题改名 · 点击节点查看信息 · 拖动空白移动</span>
    <div className="graph-tools"><button className="text-button" onClick={() => onChange({...graph, collapsed: graph.collapsed.length ? [] : [space.nodes.find(n => !n.parentId)!.id], camera: null})}><ScanLine size={14}/>归一</button><button className="icon-button" aria-label="适合画布" onClick={fit}><Expand size={15}/></button><span className="zoom-controls"><button className="icon-button" aria-label="缩小画布" onClick={() => zoom(-.1)}><Minus size={14}/></button><button aria-label="恢复百分之百" onClick={() => onChange({...graph, camera: {...camera, zoom: 1}})}>{Math.round(camera.zoom * 100)}%</button><button className="icon-button" aria-label="放大画布" onClick={() => zoom(.1)}><Plus size={14}/></button></span></div>
  </div>;
}

function MapNodeContent({node, progress, count, autoEdit, onRename, onInspect}: {node: MindNode; progress: number; count: number; autoEdit: boolean; onRename: (title: string) => void; onInspect: () => void}) {
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
      if (event.key === 'Enter' || event.key === 'Escape') {event.preventDefault(); finish(event.key === 'Enter', true);}
    }}/> : <button ref={button} className="map-node-title" aria-label={`编辑${node.title}标题`} title="点击修改标题" onClick={event=>{event.stopPropagation();begin();}} onKeyDown={event=>{if(event.key==='F2'){event.preventDefault();begin();}}}><strong>{node.title}</strong></button>}{(isTask(node) && progress === 100) && <Check size={13} className="node-completed"/>}</span>
    {isTask(node) && <span className="map-node-progress"><span className="progress-track"><i style={{width: `${progress}%`}}/></span><small>{progress}%</small></span>}
    {!!count && <button className="node-session-count" onClick={event => {event.stopPropagation(); onInspect();}}><MessageSquare size={12}/>关联会话 {count}<ChevronRight size={12}/></button>}
  </>;
  return <div className={`graph-node-content ${editing ? 'editing' : ''}`} onClick={onInspect}>{content}</div>;
}

export function NodeOverview({space, node, onProgress, onDue, onOpen, onAdd}: {space: Workspace; node: MindNode; onProgress: (id: string, progress: number) => void; onDue: (value: string) => void; onOpen: (id: string) => void; onAdd: () => void}) {
  const tasks = taskChildren(space.nodes, node.id);
  const progress = nodeProgress(space.nodes, node.id);
  return <section className="node-task-capability">{isTask(node) && <>
    <div className="field">进度 <span>{progress}%{tasks.length ? ' · 随子任务同步' : ''}</span></div>
    <label className="field">计划完成<input aria-label="计划完成日期" type="date" value={node.due} onChange={event => onDue(event.target.value)}/></label>
  </>}
    <div className="detail-section-heading"><h3>子任务（{tasks.length}）</h3><button className="text-button" disabled={space.nodes.length >= 250} onClick={onAdd}><Plus size={13}/>添加子任务</button></div>
    <div className="node-subtasks">{tasks.map(task => {const value = nodeProgress(space.nodes, task.id);return <div key={task.id}><input type="checkbox" aria-label={`完成子任务：${task.title}`} checked={value === 100} disabled={!!taskChildren(space.nodes, task.id).length} onChange={event => onProgress(task.id, event.target.checked ? 100 : 0)}/><button className="text-button" onClick={() => onOpen(task.id)}>{task.title}<span>{value}%</span><ChevronRight size={12}/></button></div>;})}</div>
  </section>;
}

export function NodeInspector({space, node, onEditBody, onClose, onFocus, children}: {space: Workspace; node: MindNode; onEditBody: (value: string) => void; onClose: () => void; onFocus: () => void; children: React.ReactNode}) {
  const content = node.body;
  const [value, setValue] = useState(content); const [focused, setFocused] = useState(false);
  const original = useRef(content); const cancelled = useRef(false);
  useEffect(() => {if (!focused) setValue(content);}, [content, focused]);
  return <aside className="node-inspector" aria-label="节点详情"><div className="inspector-meta"><span>{isTask(node) ? '任务' : '节点'} / {space.name}</span><button className="icon-button" aria-label="关闭节点详情" onClick={onClose}><X size={16}/></button></div><h2 className="node-detail-title">{node.title}</h2><textarea className="node-body-editor" aria-label="节点正文" placeholder="记录节点内容…" value={value} rows={7} onFocus={() => {original.current = content;setFocused(true);}} onChange={event => {setValue(event.target.value);onEditBody(event.target.value);}} onBlur={() => {if (!cancelled.current) onEditBody(value);cancelled.current = false;setFocused(false);}} onKeyDown={event => {if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229) {event.preventDefault();event.stopPropagation();cancelled.current = true;setValue(original.current);onEditBody(original.current);event.currentTarget.blur();}}}/>{children}<div className="inspector-footer"><button className="text-button" onClick={onFocus}><Focus size={14}/>聚焦此分支</button><span><Check size={12}/>自动保存</span></div></aside>;
}

export function TasksView({space, onOpen}: {space: Workspace; onOpen: (nodeId: string) => void}) {
  const tasks = space.nodes.filter(isTask);
  return <div className="content-page"><div className="page-heading"><h2>任务</h2><span className="muted">与图谱使用同一条记录</span></div>{tasks.map(node => <button className="task-row" key={node.id} onClick={() => onOpen(node.id)}><Lightbulb size={16}/><span><strong>{node.title}</strong><small>{node.body || ''}</small></span><span>{nodeProgress(space.nodes, node.id)}%</span><ChevronRight size={15}/></button>)}{!tasks.length && <p className="muted">在节点信息中添加子任务，完成状态会同步到地图。</p>}</div>;
}
