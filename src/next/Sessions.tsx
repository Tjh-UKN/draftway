import {useCallback,useEffect,useMemo,useState} from 'react';
import {Check, ChevronRight, CircleAlert, Files, LoaderCircle, MessageSquare, Terminal} from 'lucide-react';
import {latestRun, placeArtifact, sessionNodeIds, statusNames, type AgentRequest, type AgentSession, type WorkbenchState} from './core';
import {sessionAdapter} from './adapters';
import {agentNames} from './integrations';
import {Empty} from './ui';
import {modelCatalogDirectory, useAgentRuntime, type AgentModelOptions} from './NativeAgents';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {SessionComposer} from './SessionComposer';
import {enqueueChatMessage} from './chat-queue';
import type {ChatFile} from './session-files';
import {SessionTranscript} from './SessionTranscript';
import {RunActivity} from './RunActivity';
import {AgentComposerOptions} from './AgentComposerOptions';
import {isHtmlReport,openLocalReport} from './local-report';
import CopyButton from '../CopyButton';

export type ChangeState = (update: (state: WorkbenchState) => WorkbenchState) => void;
export function SessionStatus({state, session}: {state: WorkbenchState; session: AgentSession}) {
  const status = latestRun(state, session.id)?.state || 'idle';
  return <span className={`session-status status-${status}`}>{status === 'running' ? <LoaderCircle size={12} className="spinning"/> : <i/>}{session.unread && status === 'succeeded' ? '待查看' : statusNames[status]}</span>;
}
export function SessionRow({state, session, onOpen}: {state: WorkbenchState; session: AgentSession; onOpen: () => void}) {
  return <button className="session-row" onClick={onOpen}><MessageSquare size={17}/><span><strong>{session.title}</strong><small>{agentNames[session.agentId || 'codex']} · {session.integrationId === 'demo-agent' ? '模拟模式' : '本机会话'}</small></span><SessionStatus state={state} session={session}/><ChevronRight size={14}/></button>;
}
export function SessionView({state, session, change, onNode, active = true, visible = true}: {state: WorkbenchState; session: AgentSession; change: ChangeState; onNode: (id?: string) => void; active?: boolean; visible?: boolean}) {
  const adapter = sessionAdapter(session.integrationId);
  const runtime = useAgentRuntime();
  const demo = session.integrationId === 'demo-agent';
  const hasModelOptions = Object.hasOwn(agentNames, session.integrationId);
  const pi = session.integrationId === 'pi';
  const hasNativeProgress = session.integrationId === 'codex' || pi;
  const [modelOptions, setModelOptions] = useState<{scope: string; options?: AgentModelOptions; error?: string} | null>(null);
  const [optionsRetry, setOptionsRetry] = useState(0);
  const readModelOptions = runtime?.modelOptions;
  const {id, integrationId: backend, cwd} = session;
  const sessionRuns = useMemo(() => state.runs.filter(run => run.sessionId === id), [state.runs, id]);
  const activityRuns = hasNativeProgress ? sessionRuns : undefined;
  const unsentRuns = sessionRuns.filter(run => run.state === 'failed' && run.pendingText !== undefined);
  const directory = cwd && modelCatalogDirectory(cwd);
  const modelOptionsScope = JSON.stringify([id, backend, directory]);
  const fetchOptions = hasModelOptions && !!session.nativeRevision && visible && !runtime?.readOnly;
  useEffect(() => {
    if (!readModelOptions || !fetchOptions) return;
    let active = true;
    let request = 0;
    const refresh = () => {
      if (!active) return;
      const revision = ++request;
      void readModelOptions(id).then(
        options => {if (active && revision === request) setModelOptions({scope: modelOptionsScope, options});},
        error => {if (active && revision === request) setModelOptions(current => current?.scope === modelOptionsScope && current.options
          ? current : {scope: modelOptionsScope, error: String(error)});},
      );
    };
    setModelOptions(current => current?.scope === modelOptionsScope && current.options ? current : {scope: modelOptionsScope});
    const subscription = listen<{backend: string; cwd: string}>('agent-model-catalog', ({payload}) => {
      if (payload.backend === backend && directory && modelCatalogDirectory(payload.cwd) === directory) refresh();
    });
    void subscription.then(refresh, refresh);
    return () => {active = false; void subscription.then(unlisten => unlisten()).catch(() => {});};
  }, [readModelOptions, fetchOptions, id, backend, directory, modelOptionsScope, optionsRetry]);
  const currentOptions = modelOptions?.scope === modelOptionsScope ? modelOptions : undefined;
  const canSend = demo ? !!adapter : !!runtime && !runtime.readOnly && !!session.nativeRevision;
  const [linkError,setLinkError]=useState('');
  const openLink=useCallback((url:string)=>{setLinkError('');void invoke('open_external_url',{url}).catch(error=>setLinkError(String(error)));},[]);
  const openLocalPath=useCallback((path:string)=>{setLinkError('');if(isHtmlReport(path)){change(state=>openLocalReport(state,session.workspaceId,path));return;}void invoke('open_session_path',{id:session.id,path}).catch(error=>setLinkError(String(error)));},[session.id,session.workspaceId,change]);
  const run = latestRun(state, session.id);
  const busy = run?.state === 'running' || run?.state === 'needs_input';
  const space = state.spaces.find(s => s.id === session.workspaceId)!;
  const nodeId = sessionNodeIds(session).find(id => space.nodes.some(node => node.id === id));
  const node = space.nodes.find(item => item.id === nodeId);
  const provider = agentNames[session.agentId || 'codex'];
  const send=useCallback((text:string,files:ChatFile[]) => {
    if (!canSend) return false;
    if (!demo) {
      if (busy || session.queuedMessages?.length) {
        const message = {id:crypto.randomUUID(), text, files, model:session.selectedModel, effort:session.selectedEffort};
        change(current => enqueueChatMessage(current, session.id, message));
        return;
      }
      return runtime?.send({...session,draft:text,draftFiles:files});
    }
    if (busy) return false;
    const id = crypto.randomUUID(); const at = Date.now();
    if (adapter) change(current => adapter.start(current, session.id, text, 'succeeded', id, at));
  },[busy,canSend,demo,runtime,session,adapter,change]);
  const stop=useCallback(()=>{if(demo&&run&&adapter)change(current=>adapter.cancel(current,run.id));else runtime?.stop(session.id);},[demo,run,adapter,change,runtime,session.id]);
  return <div className="session-view" aria-label={`会话：${session.title}`}><div className="session-context"><span><Terminal size={14}/>{provider}{demo && <small className="simulation-badge">模拟</small>}</span><SessionStatus state={state} session={session}/></div>
    {!demo && session.cwd && <div className="session-directory" title={session.cwd}>{session.cwd}</div>}
    {node && <div className="session-node-context"><button className="text-button" onClick={() => onNode(node.id)}><Files size={13}/>查看节点素材 · {node.title}<ChevronRight size={12}/></button></div>}
    {linkError&&<p className="agent-error session-file-error" role="alert">{linkError}</p>}
    <SessionTranscript session={session} store={runtime?.transcripts} provider={provider} demo={demo} active={active} visible={visible} onOpenLink={runtime?openLink:undefined} onOpenLocalPath={!demo&&runtime?openLocalPath:undefined} activityRuns={activityRuns}>
      {!session.messages.length && !unsentRuns.length && <Empty title="开始对话"/>}
      {run && hasNativeProgress && <RunActivity key={run.id} run={run}/>}
      {!hasNativeProgress && run?.state === 'running' && <div className="run-progress"><LoaderCircle size={15} className="spinning"/><span>{run.stopping ? '正在停止…' : '正在回复…'}</span></div>}
      {run?.state === 'needs_input' && demo && <div className="run-attention"><CircleAlert size={16}/><span>需要你的输入</span><button className="primary-button" disabled={!adapter} onClick={() => {const at = Date.now(); change(current => adapter!.resume(current, run.id, at));}}>继续模拟</button></div>}
      {!demo && session.requests?.map(request => <AgentRequestForm key={request.id} request={request} onRespond={answer => runtime?.respond(session.id, request.id, answer)}/>)}
      {(session.connectionError || (run?.pendingText === undefined && run?.error)) && <p className="agent-error" role="alert">{session.connectionError || run?.error}</p>}
      {unsentRuns.map(failed => {
        const text = failed.pendingText;
        if (failed.state !== 'failed' || text === undefined) return null;
        return <section className="agent-request unsent-agent-message" aria-label="未发送消息" key={failed.id}>
          <strong>未发送</strong>
          {failed.error && <p role="alert">{failed.error}</p>}
          {text && <pre>{text}</pre>}
          {!!failed.pendingFiles?.length && <p>{failed.pendingFiles.map(file=>file.name).join('、')}</p>}
          <div className="agent-request-actions">
            <button type="button" className="outline-button" disabled={!canSend || busy} onClick={() => runtime?.send(session,{id:failed.id,text,files:failed.pendingFiles})}>重试</button>
            {!!text.trim() && <CopyButton text={text} label="复制未发送消息"/>}
          </div>
        </section>;
      })}
      {run?.state === 'interrupted' && <p className="quiet-note" role="status">Draftway 退出时本轮尚未结束，消息的处理结果可能尚未确认。查看记录后，可输入新消息继续此会话。</p>}
      {run?.state === 'cancelled' && <p className="quiet-note">本轮已停止。会话记录保留。</p>}
      {state.artifacts.filter(a => a.sessionId === session.id).map(artifact => {const placed = space.nodes.find(n => n.sourceArtifactId === artifact.id); return <details className="artifact" key={artifact.id}><summary><Check size={14}/>{artifact.title}</summary><p>{artifact.text}</p><button className="text-button" disabled={!placed && space.nodes.length >= 250} onClick={() => {const at = Date.now(); change(current => placeArtifact(current, artifact.id, at)); onNode(placed?.id || `artifact-${artifact.id}`);}}>{placed ? '查看地图节点' : '保留到地图'}<ChevronRight size={13}/></button></details>;})}
      {run?.context && <details className="artifact"><summary>本轮引用的节点与材料</summary><pre className="material-text">{run.context}</pre></details>}
    </SessionTranscript>
    <SessionComposer key={session.id} session={session} change={change} active={active} busy={busy} stopping={!!run?.stopping} disabled={demo?!adapter:!runtime} canSend={canSend} onSend={send} onStop={stop} queueEnabled={!demo}
      options={runtime && hasModelOptions && <AgentComposerOptions provider={provider} options={currentOptions?.options}
        error={currentOptions?.error ?? (runtime.readOnly ? '会话为只读' : !session.nativeRevision ? session.connectionError : undefined)}
        model={session.selectedModel} effort={session.selectedEffort} effectiveModel={session.effectiveModel} effectiveEffort={session.effectiveEffort}
        disabled={busy || !!runtime.readOnly || !session.nativeRevision}
        onSelect={(model, effort)=>change(current=>({
          ...current,
          sessions:current.sessions.map(item=>item.id===session.id ? {...item,selectedModel:model,selectedEffort:effort} : item),
        }))}
        onRetry={()=>setOptionsRetry(attempt=>attempt+1)}/>}/>
    <p className="composer-footnote">{demo ? '模拟模式 · 尚未连接真实 Agent' : runtime ? session.nativeRevision ? '由本机执行器运行 · 记录保存在 Draftway' : session.connectionError ? '会话未就绪，请查看上方错误。' : '正在创建会话…' : '请在 Windows 版继续此会话'}</p>
  </div>;
}

function AgentRequestForm({request, onRespond}: {request: AgentRequest; onRespond: (answer: unknown) => void}) {
  if(request.kind==='elicitation')return <ElicitationForm request={request} onRespond={onRespond}/>;
  return <InputRequestForm request={request} onRespond={onRespond}/>;
}
function ElicitationForm({request,onRespond}: {request:AgentRequest;onRespond:(answer:unknown)=>void}) {
  const [content,setContent]=useState<Record<string,unknown>>({});
  const schema=request.payload.requestedSchema as {properties?:Record<string,{type?:string;title?:string;enum?:string[]}>;required?:string[]}|undefined;
  const properties=Object.entries(schema?.properties||{});const supported=properties.every(([,value])=>['string','boolean','number','integer'].includes(value.type||''));
  return <section className="agent-request"><strong>工具请求</strong><p>{request.title}</p><form onSubmit={event=>{event.preventDefault();onRespond({action:'accept',content});}}>{supported && properties.map(([key,field])=><label className="field" key={key}>{field.title||key}{field.type==='boolean'?<input type="checkbox" checked={!!content[key]} onChange={e=>setContent(old=>({...old,[key]:e.target.checked}))}/>:field.enum?<select required={schema?.required?.includes(key)} value={String(content[key]||'')} onChange={e=>setContent(old=>({...old,[key]:e.target.value}))}><option value="">请选择</option>{field.enum.map(option=><option key={option}>{option}</option>)}</select>:<input type={field.type==='string'?'text':'number'} step={field.type==='integer'?'1':'any'} required={schema?.required?.includes(key)} onChange={e=>setContent(old=>({...old,[key]:field.type==='string'?e.target.value:Number(e.target.value)}))}/>}</label>)}<div className="agent-request-actions"><button className="primary-button" disabled={!supported}>允许本次</button><button type="button" className="outline-button" onClick={()=>onRespond({action:'decline',content:null})}>拒绝</button></div>{!supported && <p className="quiet-note">此表单格式暂不支持，可以拒绝或停止本轮。</p>}</form></section>;
}
function InputRequestForm({request, onRespond}: {request: AgentRequest; onRespond: (answer: unknown) => void}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = (Array.isArray(request.payload.questions) ? request.payload.questions : []) as {id: string; question: string; isSecret?: boolean; options?: {label: string; description?: string}[]}[];
  return <section className="agent-request"><strong>{request.kind === 'approval' ? '需要你的允许' : '需要你的输入'}</strong><p>{request.title}</p>{typeof request.payload.command === 'string' && <pre>{request.payload.command}</pre>}{typeof request.payload.cwd === 'string' && <small>{request.payload.cwd}</small>}
    {request.kind === 'approval' ? <div className="agent-request-actions"><button className="primary-button" onClick={() => onRespond({decision: 'accept'})}>允许本次</button><button className="outline-button" onClick={() => onRespond({decision: 'decline'})}>拒绝</button></div> : request.kind === 'input' ? <form onSubmit={event => {event.preventDefault(); onRespond({answers: Object.fromEntries(questions.map(question => [question.id, {answers: [answers[question.id] || '']}]))});}}>{questions.map(question => <label className="field" key={question.id}>{question.question}{question.options?.map(option => <button type="button" className="outline-button" key={option.label} onClick={() => setAnswers(all => ({...all, [question.id]: option.label}))}>{option.label}</button>)}<input type={question.isSecret ? 'password' : 'text'} required value={answers[question.id] || ''} onChange={event => setAnswers(all => ({...all, [question.id]: event.target.value}))}/></label>)}<button className="primary-button">继续</button></form> : <p>执行器要求的交互暂不支持，可停止本轮后继续。</p>}
  </section>;
}
