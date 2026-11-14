import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {ArrowLeft, Check, ChevronRight, Code2, Expand, FileText, Focus, Folder, Layers, Lightbulb, MessageSquare, Minus, Plus, ScanLine, X} from 'lucide-react';
import {nodeProgress, placeNodes, type MindNode, type NodeKind} from './model';
import type {GraphState, Workspace} from './core';

export const nodeKindNames: Record<NodeKind, string> = {root: '工作区', idea: '想法', analysis: '分析', event: '任务', document: '文档', code: '代码', artifact: '产物'};
export function NodeGlyph({kind, size = 18}: {kind: NodeKind; size?: number}) {
  const Icon = {root: Folder, idea: Lightbulb, analysis: ScanLine, event: Check, document: FileText, code: Code2, artifact: Layers}[kind];
  return <Icon size={size}/>;
}
export const placeWorkspaceNodes = (space: Workspace) => placeNodes(space.nodes.map(n => ({...n, side: 1 as const})), space.graph.collapsed, space.graph.focusId);
export function GraphView({space, onChange, onAdd, sessionCounts}: {space: Workspace; onChange: (graph: GraphState) => void; onAdd: (parentId: string) => void; sessionCounts: Record<string, number>}) {
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
    const zoom = Math.max(.65, Math.min(1, (frame.current.clientWidth - 90) / (right - left), (frame.current.clientHeight - 100) / (bottom - top)));
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
      if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
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
          <button className="graph-node-content" aria-label={`${nodeKindNames[node.kind]}：${node.title}`} onClick={() => onChange({...graph, selectedId: node.id})}>
            <span className="map-node-heading"><NodeGlyph kind={node.kind}/><strong title={node.title}>{node.title}</strong>{(node.completed || (node.kind === 'event' && progress === 100)) && <Check size={13} className="node-completed"/>}</span>
            {node.kind === 'event' && <span className="map-node-progress"><span className="progress-track"><i style={{width: `${progress}%`}}/></span><small>{progress}%</small></span>}
            {!!count && <span className="node-session-count"><MessageSquare size={12}/>关联会话 {count}<ChevronRight size={12}/></span>}
          </button>
          <button className="graph-node-add" aria-label={`在${node.title}下添加节点`} onClick={() => onAdd(node.id)}><Plus size={13}/></button>
          {children && <button className="graph-node-collapse" aria-label={`${graph.collapsed.includes(node.id) ? '展开' : '收起'}${node.title}分支`} onClick={() => onChange({...graph, collapsed: graph.collapsed.includes(node.id) ? graph.collapsed.filter(id => id !== node.id) : [...graph.collapsed, node.id]})}>{graph.collapsed.includes(node.id) ? '+' : '−'}</button>}
        </div>;
      })}
    </div>
    <span className="graph-hint">拖动地图 · 点击节点查看内容</span>
    <div className="graph-tools"><button className="text-button" onClick={() => onChange({...graph, collapsed: graph.collapsed.length ? [] : [space.nodes.find(n => !n.parentId)!.id], camera: null})}><ScanLine size={14}/>归一</button><button className="icon-button" aria-label="适合画布" onClick={fit}><Expand size={15}/></button><span className="zoom-controls"><button className="icon-button" aria-label="缩小画布" onClick={() => zoom(-.1)}><Minus size={14}/></button><button aria-label="恢复百分之百" onClick={() => onChange({...graph, camera: {...camera, zoom: 1}})}>{Math.round(camera.zoom * 100)}%</button><button className="icon-button" aria-label="放大画布" onClick={() => zoom(.1)}><Plus size={14}/></button></span></div>
  </div>;
}

export function NodeOverview({node, onChange}: {node: MindNode; onChange: (node: MindNode) => void}) {
  const [stepTitle, setStepTitle] = useState('');
  return <div className="node-overview">
    {node.kind !== 'root' && <label className="field">节点类型<select aria-label="节点类型" value={node.kind} onChange={event => onChange({...node, kind: event.target.value as NodeKind})}>{Object.entries(nodeKindNames).filter(([id]) => id !== 'root').map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>}
    <label className="field">说明<textarea aria-label="节点描述" rows={5} value={node.body} placeholder="留下想法、分析或完成条件" onChange={event => onChange({...node, body: event.target.value})}/></label>
    {['document', 'code', 'artifact'].includes(node.kind) && <label className="completion-toggle"><input type="checkbox" checked={!!node.completed} onChange={event => onChange({...node, completed: event.target.checked})}/>标记为完成</label>}
    {node.kind === 'event' && <>
      <label className="field">任务进度 <span>{node.progress}%{node.steps.length > 0 ? ' · 随步骤同步' : ''}</span><input aria-label="任务进度" type="range" min="0" max="100" step="5" disabled={node.steps.length > 0} value={node.progress} onChange={event => onChange({...node, progress: Number(event.target.value)})}/></label>
      <label className="field">计划完成<input aria-label="计划完成日期" type="date" value={node.due} onChange={event => onChange({...node, due: event.target.value})}/></label>
      <div className="section-label">行动步骤</div><div className="step-list">{node.steps.map(step => <label key={step.id}><input type="checkbox" checked={step.done} onChange={event => {const steps = node.steps.map(s => s.id === step.id ? {...s, done: event.target.checked} : s); onChange({...node, steps, progress: Math.round(steps.filter(s => s.done).length / steps.length * 100)});}}/><span>{step.title}</span></label>)}</div>
      <form className="step-form" onSubmit={event => {event.preventDefault(); if (!stepTitle.trim() || node.steps.length >= 100) return; const steps = [...node.steps, {id: crypto.randomUUID(), title: stepTitle.trim(), done: false}]; onChange({...node, steps, progress: Math.round(steps.filter(s => s.done).length / steps.length * 100)}); setStepTitle('');}}><input aria-label="添加行动步骤" maxLength={120} placeholder="添加一个步骤" value={stepTitle} onChange={event => setStepTitle(event.target.value)}/><button className="icon-button" aria-label="保存行动步骤" disabled={!stepTitle.trim()}><Plus size={16}/></button></form>
    </>}
  </div>;
}

export function NodeInspector({space, node, onChange, onClose, onFocus, children, autoFocusTitle = false}: {space: Workspace; node: MindNode; autoFocusTitle?: boolean; onChange: (node: MindNode) => void; onClose: () => void; onFocus: () => void; children: React.ReactNode}) {
  const [title, setTitle] = useState(node.title);
  const titleEditor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {if (autoFocusTitle) {titleEditor.current?.focus(); titleEditor.current?.select();}}, [autoFocusTitle, node.id]);
  const commit = () => {if (title.trim()) onChange({...node, title: title.trim()}); else setTitle(node.title);};
  const progress = nodeProgress(space.nodes, node.id);
  return <aside className="node-inspector" aria-label="节点详情"><div className="inspector-meta"><span>{nodeKindNames[node.kind]}节点 / {space.name}</span><button className="icon-button" aria-label="关闭节点详情" onClick={onClose}><X size={16}/></button></div><textarea ref={titleEditor} className="node-title" aria-label="节点标题" value={title} maxLength={120} rows={2} onChange={event => {const value = event.target.value; setTitle(value); if (value.trim()) onChange({...node, title: value.trim()});}} onBlur={commit} onKeyDown={event => {if (event.key === 'Enter' && !event.shiftKey) {event.preventDefault(); event.currentTarget.blur();}}}/>{node.kind === 'event' && <div className="inspector-progress"><span>{progress === 100 ? '已完成' : progress ? '进行中' : '待开始'}</span><span>{progress}%</span><div className="progress-track"><i style={{width: `${progress}%`}}/></div></div>}{children}<div className="inspector-footer"><button className="text-button" onClick={onFocus}><Focus size={14}/>聚焦此分支</button><span><Check size={12}/>自动保存</span></div></aside>;
}

export function TasksView({space, onOpen}: {space: Workspace; onOpen: (nodeId: string) => void}) {
  const tasks = space.nodes.filter(n => n.kind === 'event');
  return <div className="content-page"><div className="page-heading"><h2>任务</h2><span className="muted">与图谱使用同一条记录</span></div>{tasks.map(node => <button className="task-row" key={node.id} onClick={() => onOpen(node.id)}><Lightbulb size={16}/><span><strong>{node.title}</strong><small>{node.body || '尚未填写说明'}</small></span><span>{node.progress}%</span><ChevronRight size={15}/></button>)}{!tasks.length && <p className="muted">在图谱中添加任务节点，或将已有节点转为任务。</p>}</div>;
}
