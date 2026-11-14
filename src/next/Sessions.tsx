import {useEffect, useRef, useState} from 'react';
import {Check, ChevronRight, CircleAlert, LoaderCircle, MessageSquare, Send, Square, Terminal} from 'lucide-react';
import {latestRun, placeArtifact, statusNames, type AgentRequest, type AgentSession, type WorkbenchState} from './core';
import {sessionAdapter} from './adapters';
import {agentNames} from './integrations';
import {Empty} from './ui';
import {useAgentRuntime} from './NativeAgents';
import MarkdownView from '../MarkdownView';
import {invoke} from '@tauri-apps/api/core';

export type ChangeState = (update: (state: WorkbenchState) => WorkbenchState) => void;
export function SessionStatus({state, session}: {state: WorkbenchState; session: AgentSession}) {
  const status = latestRun(state, session.id)?.state || 'idle';
  return <span className={`session-status status-${status}`}>{status === 'running' ? <LoaderCircle size={12} className="spinning"/> : <i/>}{session.unread && status === 'succeeded' ? '待查看' : statusNames[status]}</span>;
}
export function SessionRow({state, session, onOpen}: {state: WorkbenchState; session: AgentSession; onOpen: () => void}) {
  return <button className="session-row" onClick={onOpen}><MessageSquare size={17}/><span><strong>{session.title}</strong><small>{agentNames[session.agentId || 'codex']} · {session.integrationId === 'demo-agent' ? '模拟模式' : '本机会话'}</small></span><SessionStatus state={state} session={session}/><ChevronRight size={14}/></button>;
}
export function SessionView({state, session, change, onNode, active = true}: {state: WorkbenchState; session: AgentSession; change: ChangeState; onNode: (id?: string) => void; active?: boolean}) {
  const adapter = sessionAdapter(session.integrationId);
  const runtime = useAgentRuntime();
  const demo = session.integrationId === 'demo-agent';
  const canSend = demo ? !!adapter : !!runtime && !!session.nativeRevision;
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
    if (!demo) {runtime?.send(session); return;}
    const id = crypto.randomUUID(); const at = Date.now();
    if (adapter) change(current => adapter.start(current, session.id, session.draft, 'succeeded', id, at));
  }
  return <div className="session-view" aria-label={`会话：${session.title}`}><div className="session-context"><span><Terminal size={14}/>{provider}{demo && <small className="simulation-badge">模拟</small>}</span><SessionStatus state={state} session={session}/></div>
    {!demo && session.cwd && <div className="session-directory" title={session.cwd}>{session.cwd}</div>}
    {node && <div className="session-node-context"><button className="text-button" onClick={() => onNode(node.id)}>{node.title}<ChevronRight size={12}/></button></div>}
    <div className="transcript" aria-live="polite">
      {!session.messages.length && <Empty title="开始对话"/>}
      {session.messages.map(message => <article className={`message message-${message.role}`} key={message.id}><span className="message-role">{message.role === 'user' ? '你' : `${provider}${demo ? ' · 模拟回复' : ''}`}</span>{message.role === 'assistant' ? <MarkdownView value={message.text} onOpenLink={runtime ? url => {void invoke('open_external_url', {url});} : undefined}/> : <div>{message.text}</div>}</article>)}
      {run?.state === 'running' && <div className="run-progress"><LoaderCircle size={15} className="spinning"/><span>{run.stopping ? '正在停止…' : '正在回复…'}</span></div>}
      {run?.state === 'needs_input' && demo && <div className="run-attention"><CircleAlert size={16}/><span>需要你的输入</span><button className="primary-button" disabled={!adapter} onClick={() => {const at = Date.now(); change(current => adapter!.resume(current, run.id, at));}}>继续模拟</button></div>}
      {!demo && session.requests?.map(request => <AgentRequestForm key={request.id} request={request} onRespond={answer => runtime?.respond(session.id, request.id, answer)}/>)}
      {(session.connectionError || run?.error) && <p className="agent-error" role="alert">{session.connectionError || run?.error}</p>}
      {run?.state === 'cancelled' && <p className="quiet-note">本轮已停止。会话记录保留。</p>}
      {state.artifacts.filter(a => a.sessionId === session.id).map(artifact => {const placed = space.nodes.find(n => n.sourceArtifactId === artifact.id); return <details className="artifact" key={artifact.id}><summary><Check size={14}/>{artifact.title}</summary><p>{artifact.text}</p><button className="text-button" disabled={!placed && space.nodes.length >= 250} onClick={() => {const at = Date.now(); change(current => placeArtifact(current, artifact.id, at)); onNode(placed?.id || `artifact-${artifact.id}`);}}>{placed ? '查看地图节点' : '保留到地图'}<ChevronRight size={13}/></button></details>;})}
      <div ref={end}/>
    </div>
    <form className="session-composer" onSubmit={event => {event.preventDefault(); send();}}><textarea ref={composer} autoFocus={active} aria-label="会话消息" placeholder={busy ? '先写下下一步，草稿会保留' : '在这里输入消息…'} value={session.draft} maxLength={20000} disabled={demo ? !adapter : !runtime} onChange={event => {const draft = event.target.value; change(current => ({...current, sessions: current.sessions.map(s => s.id === session.id ? {...s, draft} : s)}));}} onKeyDown={event => {if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {event.preventDefault(); send();}}}/>
      <div className="composer-toolbar chat-composer-actions">{busy ? <button type="button" className="icon-button stop-button" disabled={(demo ? !adapter : !runtime) || run?.stopping} aria-label={demo ? '停止模拟' : '停止生成'} onClick={() => {if (demo) change(current => adapter!.cancel(current, run!.id)); else runtime?.stop(session.id);}}><Square size={14}/></button> : <button className="send-button" aria-label="发送消息" disabled={!session.draft.trim() || !canSend}><Send size={15}/></button>}</div>

    </form><p className="composer-footnote">{demo ? '模拟模式 · 尚未连接真实 Agent' : runtime ? session.nativeRevision ? '由本机执行器运行 · 记录保存在北极星' : '正在创建会话…' : '请在 Windows 版继续此会话'}</p>
  </div>;
}

function AgentRequestForm({request, onRespond}: {request: AgentRequest; onRespond: (answer: unknown) => void}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = (Array.isArray(request.payload.questions) ? request.payload.questions : []) as {id: string; question: string; isSecret?: boolean; options?: {label: string; description?: string}[]}[];
  return <section className="agent-request"><strong>{request.kind === 'approval' ? '需要你的允许' : '需要你的输入'}</strong><p>{request.title}</p>{typeof request.payload.command === 'string' && <pre>{request.payload.command}</pre>}{typeof request.payload.cwd === 'string' && <small>{request.payload.cwd}</small>}
    {request.kind === 'approval' ? <div className="agent-request-actions"><button className="primary-button" onClick={() => onRespond({decision: 'accept'})}>允许本次</button><button className="outline-button" onClick={() => onRespond({decision: 'decline'})}>拒绝</button></div> : request.kind === 'input' ? <form onSubmit={event => {event.preventDefault(); onRespond({answers: Object.fromEntries(questions.map(question => [question.id, {answers: [answers[question.id] || '']}]))});}}>{questions.map(question => <label className="field" key={question.id}>{question.question}{question.options?.map(option => <button type="button" className="outline-button" key={option.label} onClick={() => setAnswers(all => ({...all, [question.id]: option.label}))}>{option.label}</button>)}<input type={question.isSecret ? 'password' : 'text'} required value={answers[question.id] || ''} onChange={event => setAnswers(all => ({...all, [question.id]: event.target.value}))}/></label>)}<button className="primary-button">继续</button></form> : <p>执行器要求的交互暂不支持，可停止本轮后继续。</p>}
  </section>;
}
