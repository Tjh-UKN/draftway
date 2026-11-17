import {type AgentRequest, type AgentSession, type Message, type RunState, type WorkbenchState} from './core';
import {groups} from './docking';
import {reuseMessages} from './session-transcript';

export interface NativeSession {
  id: string; workspaceId: string; nodeId: string | null; backend: NonNullable<AgentSession['agentId']>; title: string;
  cwd: string; sourceId: string | null; createdAt: number; revision: number; messages: Message[];
  runs: {id: string; state: RunState; startedAt: number; finishedAt: number | null; error: string | null; cancelRequested?: boolean; context?: string | null}[];
  requests: AgentRequest[]; error: string | null;
}
export function beginNativeSend(state:WorkbenchState,id:string,runId:string,text:string,at:number):WorkbenchState {
  return {...state,runs:[...state.runs,{id:runId,sessionId:id,state:'running',startedAt:at,dueAt:at}],sessions:state.sessions.map(session=>session.id===id?{...session,draft:'',connectionError:undefined,messages:[...session.messages,{id:`${runId}-user`,role:'user',text,at}]}:session)};
}
export function rejectNativeSend(state:WorkbenchState,id:string,runId:string,text:string,revision:number|undefined,error:string):WorkbenchState {
  const unaccepted=state.sessions.find(session=>session.id===id)?.nativeRevision===revision;
  return {...state,runs:unaccepted?state.runs.filter(run=>run.id!==runId):state.runs,sessions:state.sessions.map(session=>session.id===id?{...session,connectionError:error,draft:session.draft||text,messages:unaccepted?session.messages.filter(message=>message.id!==`${runId}-user`):session.messages}:session)};
}
export function mergeNativeSession(state: WorkbenchState, native: NativeSession, foreground = true, notify = true): WorkbenchState {
  const space = state.spaces.find(space => space.id === native.workspaceId);
  const old = state.sessions.find(session => session.id === native.id);
  if (!space || (old && old.workspaceId !== native.workspaceId) || (old?.nativeRevision || 0) >= native.revision) return state;
  const visible = foreground && state.activeId === space.id && groups(space.dock.root).some(group => group.activeId === native.id);
  const changed = native.runs.filter(run => ['succeeded', 'failed', 'needs_input'].includes(run.state) && state.runs.find(old => old.id === run.id)?.state !== run.state);
  const linked=old?old.nodeId:native.nodeId;
  const nodeId=space.nodes.some(n=>n.id===linked)?linked:null;
  const session: AgentSession = {...old, id: native.id, workspaceId: native.workspaceId, nodeId, agentId: native.backend, integrationId: native.backend, title: native.title, messages: reuseMessages(old?.messages||[],native.messages), draft: old?.draft || '', createdAt: native.createdAt, unread: !visible && (!!changed.length || !!old?.unread), cwd: native.cwd, sourceId: native.sourceId, nativeRevision: native.revision, requests: native.requests, connectionError: native.error || undefined};
  const runIds = new Set(native.runs.map(run => run.id));
  const runs = [...state.runs.filter(run => !runIds.has(run.id)), ...native.runs.map(run => ({id: run.id, sessionId: native.id, state: run.state, startedAt: run.startedAt, dueAt: run.finishedAt || run.startedAt, error: run.error, context: run.context || undefined, stopping: !!run.cancelRequested && run.state === 'running'}))];
  const notices = [...state.notices]; const artifacts = [...state.artifacts];
  for (const run of changed) {
    const id = `native-${run.id}-${run.state}`;
    if (notify && !visible && !notices.some(notice => notice.id === id)) notices.push({id, runId: run.id, workspaceId: native.workspaceId, sessionId: native.id, title: run.state === 'succeeded' ? '执行完成' : run.state === 'needs_input' ? '需要你的输入' : '执行失败', read: false, at: run.finishedAt || Date.now()});
  }
  for (const run of native.runs.filter(run => run.state === 'succeeded')) {
    const id = `native-${run.id}-artifact`;
    if (artifacts.some(artifact => artifact.id === id)) continue;
    const text = native.messages.filter(message => message.role === 'assistant' && message.id.startsWith(`${run.id}-`)).map(message => message.text).join('\n\n');
    if (text.trim()) artifacts.push({id, sessionId: native.id, runId: run.id, title: native.title, text});
  }
  return {...state, sessions: old ? state.sessions.map(s => s.id === native.id ? session : s) : [...state.sessions, session], runs, notices, artifacts};
}
