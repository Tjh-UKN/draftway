import {ExternalLink, Globe, Plus} from 'lucide-react';
import type {ComponentType} from 'react';
import {renameMapNode, type GraphState, type Surface, type WorkbenchState, type Workspace} from './core';
import {GraphView, TasksView} from './Graph';
import {safeWebUrl} from './model';
import {SessionView, type ChangeState} from './Sessions';
import {Empty} from './ui';

export interface SurfaceProps {
  state: WorkbenchState; space: Workspace; surface: Surface; change: ChangeState;
  onGraph: (graph: GraphState) => void; onAddNode: (id: string) => void;
  onOpenNode: (id: string) => void; onSurface: (surface: Surface) => void;
}
function GraphSurface(props: SurfaceProps) {
  const counts: Record<string, number> = {};
  for (const session of props.state.sessions) if (session.workspaceId === props.space.id && session.nodeId) counts[session.nodeId] = (counts[session.nodeId] || 0) + 1;
  return <GraphView space={props.space} onChange={props.onGraph} onAdd={props.onAddNode} onRename={(id,title)=>props.change(state=>renameMapNode(state,props.space.id,id,title))} sessionCounts={counts}/>;
}
function NoteSurface({surface, onSurface}: SurfaceProps) {
  return <div className="note-surface"><input aria-label="笔记标题" className="note-title" value={surface.title} maxLength={80} onChange={event => onSurface({...surface, title: event.target.value})}/><textarea aria-label="笔记正文" value={surface.text || ''} placeholder="留下一点想法。" onChange={event => onSurface({...surface, text: event.target.value})}/><span className="quiet-note">本地自动保存</span></div>;
}
function WebSurface({surface, onSurface}: SurfaceProps) {
  let destination = '';
  try {destination = safeWebUrl(surface.url || '');} catch { /* Keep invalid saved input editable. */ }
  return <div className="web-surface"><Globe size={30}/><h2>{surface.title}</h2><p>连接你正在使用的网页工具。</p><label className="field">网页地址<input aria-label="网页地址" placeholder="http://127.0.0.1:8765/" value={surface.url || ''} onChange={event => onSurface({...surface, url: event.target.value})}/></label>{destination ? <a className="primary-button" href={destination} target="_blank" rel="noopener noreferrer">打开原页面<ExternalLink size={14}/></a> : <span className="quiet-note">请输入完整的 HTTP / HTTPS 地址</span>}<p className="quiet-note">第一阶段保存入口，在独立页面操作。原页面内嵌和状态同步在接入阶段实现。</p></div>;
}
function AgentSurface(props: SurfaceProps) {
  const session = props.state.sessions.find(s => s.id === props.surface.resourceId);
  if (!session) return <Empty title="会话不可用"/>;
  return <SessionView state={props.state} session={session} change={props.change} onNode={() => session.nodeId && props.onOpenNode(session.nodeId)}/>;
}

// Built-in surface registration is the only place that maps a type to its view.
const surfaceViews: Record<string, ComponentType<SurfaceProps>> = {
  graph: GraphSurface,
  tasks: props => <TasksView space={props.space} onOpen={props.onOpenNode}/>,
  note: NoteSurface,
  web: WebSurface,
  session: AgentSurface,
};
export function SurfaceHost(props: SurfaceProps) {
  const View = surfaceViews[props.surface.integrationId];
  return View ? <View {...props}/> : <Empty title="这个视图暂不可用"><p>接入类型：{props.surface.integrationId}。配置已保留。</p></Empty>;
}
export function EmptyPane({onAdd}: {onAdd: () => void}) {
  return <Empty title="留出一个新的可能"><button className="text-button" onClick={onAdd}><Plus size={15}/>添加视图</button></Empty>;
}
