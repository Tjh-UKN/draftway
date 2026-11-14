import {useEffect, useRef} from 'react';
import {Check, ChevronRight, CircleAlert, LoaderCircle, MessageSquare, Send, Square, Terminal} from 'lucide-react';
import {latestRun, placeArtifact, statusNames, type AgentSession, type WorkbenchState} from './core';
import {sessionAdapter} from './adapters';
import {agentNames} from './integrations';
import {Empty} from './ui';

export type ChangeState = (update: (state: WorkbenchState) => WorkbenchState) => void;
export function SessionStatus({state, session}: {state: WorkbenchState; session: AgentSession}) {
  const status = latestRun(state, session.id)?.state || 'idle';
  return <span className={`session-status status-${status}`}>{status === 'running' ? <LoaderCircle size={12} className="spinning"/> : <i/>}{session.unread && status === 'succeeded' ? '待查看' : statusNames[status]}</span>;
}
export function SessionRow({state, session, onOpen}: {state: WorkbenchState; session: AgentSession; onOpen: () => void}) {
  return <button className="session-row" onClick={onOpen}><MessageSquare size={17}/><span><strong>{session.title}</strong><small>{agentNames[session.agentId || 'codex']} · {session.integrationId === 'demo-agent' ? '模拟模式' : '尚未连接'}</small></span><SessionStatus state={state} session={session}/><ChevronRight size={14}/></button>;
}
export function SessionView({state, session, change, onNode, active = true}: {state: WorkbenchState; session: AgentSession; change: ChangeState; onNode: (id?: string) => void; active?: boolean}) {
  const adapter = sessionAdapter(session.integrationId);
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {if (active && !(document.activeElement as HTMLElement | null)?.closest('[role="tablist"]')) composer.current?.focus();}, [active, session.id]);
  const run = latestRun(state, session.id);
  const busy = run?.state === 'running' || run?.state === 'needs_input';
  const space = state.spaces.find(s => s.id === session.workspaceId)!;
  const node = space.nodes.find(n => n.id === session.nodeId);
  const provider = agentNames[session.agentId || 'codex'];
  useEffect(() => {end.current?.scrollIntoView({block: 'nearest', behavior: 'smooth'});}, [session.messages.length, run?.state]);
  function send() {
    if (busy) return;
    const id = crypto.randomUUID(); const at = Date.now();
    if (adapter) change(current => adapter.start(current, session.id, session.draft, 'succeeded', id, at));
  }
  return <div className="session-view" aria-label={`会话：${session.title}`}><div className="session-context"><span><Terminal size={14}/>{provider}<small className="simulation-badge">模拟</small></span><SessionStatus state={state} session={session}/></div>
    {node && <div className="session-node-context"><button className="text-button" onClick={() => onNode(node.id)}>{node.title}<ChevronRight size={12}/></button></div>}
    <div className="transcript" aria-live="polite">
      {!session.messages.length && <Empty title="开始对话"/>}
      {session.messages.map(message => <article className={`message message-${message.role}`} key={message.id}><span className="message-role">{message.role === 'user' ? '你' : `${provider} · 模拟回复`}</span><div>{message.text}</div></article>)}
      {run?.state === 'running' && <div className="run-progress"><LoaderCircle size={15} className="spinning"/><span>正在回复…</span></div>}
      {run?.state === 'needs_input' && <div className="run-attention"><CircleAlert size={16}/><span>需要你的输入</span><button className="primary-button" disabled={!adapter} onClick={() => {const at = Date.now(); change(current => adapter!.resume(current, run.id, at));}}>继续模拟</button></div>}
      {run?.state === 'cancelled' && <p className="quiet-note">本轮模拟已停止。会话记录保留。</p>}
      {state.artifacts.filter(a => a.sessionId === session.id).map(artifact => {const placed = space.nodes.find(n => n.sourceArtifactId === artifact.id); return <details className="artifact" key={artifact.id}><summary><Check size={14}/>{artifact.title}</summary><p>{artifact.text}</p><button className="text-button" disabled={!placed && space.nodes.length >= 250} onClick={() => {const at = Date.now(); change(current => placeArtifact(current, artifact.id, at)); onNode(placed?.id || `artifact-${artifact.id}`);}}>{placed ? '查看地图节点' : '保留到地图'}<ChevronRight size={13}/></button></details>;})}
      <div ref={end}/>
    </div>
    <form className="session-composer" onSubmit={event => {event.preventDefault(); send();}}><textarea ref={composer} autoFocus={active} aria-label="会话消息" placeholder={busy ? '先写下下一步，草稿会保留' : '在这里输入消息…'} value={session.draft} maxLength={20000} disabled={!adapter} onChange={event => {const draft = event.target.value; change(current => ({...current, sessions: current.sessions.map(s => s.id === session.id ? {...s, draft} : s)}));}} onKeyDown={event => {if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {event.preventDefault(); send();}}}/>
      <div className="composer-toolbar chat-composer-actions">{busy ? <button type="button" className="icon-button stop-button" disabled={!adapter} aria-label="停止模拟" onClick={() => change(current => adapter!.cancel(current, run!.id))}><Square size={14}/></button> : <button className="send-button" aria-label="发送消息" disabled={!session.draft.trim() || !adapter}><Send size={15}/></button>}</div>

    </form><p className="composer-footnote">{adapter ? '模拟模式 · 尚未连接真实 Agent' : '适配器不可用，会话记录已保留'}</p>
  </div>;
}
