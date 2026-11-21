import {type AgentRequest, type AgentSession, type Message, type Run, type WorkbenchState} from './core';
import {groups} from './docking';
import {reuseMessages} from './session-transcript';
import {canStartQueuedMessage, pauseChatQueue} from './chat-queue';
import type {ChatFile} from './session-files';

export interface NativeSession {
  id: string; workspaceId: string; nodeId: string | null; backend: NonNullable<AgentSession['agentId']>; title: string;
  cwd: string; sourceId: string | null; createdAt: number; revision: number; messages: Message[];
  runs: (Pick<Run, 'id' | 'state' | 'startedAt' | 'phase' | 'activity'> & {finishedAt: number | null; error: string | null; cancelRequested?: boolean; context?: string | null})[];
  requests: AgentRequest[]; error: string | null;
  effectiveModel?: string | null; effectiveEffort?: string | null;
}
export function beginNativeSend(state: WorkbenchState, id: string, runId: string, text: string, at: number,
  retry = false, files: ChatFile[] = [], queued = false): WorkbenchState {
  if (queued && !canStartQueuedMessage(state, id, runId)) return state;
  if (retry && !state.runs.some(run => run.id === runId && run.sessionId === id && run.state === 'failed' && run.pendingText === text)) return state;
  const agent = state.sessions.find(session => session.id === id)?.agentId;
  const phase = agent === 'codex' || agent === 'pi' ? 'sending' : undefined;
  const fileFields = files.length ? {files} : {};
  return {
    ...state,
    runs: [...state.runs.filter(run => run.id !== runId), {
      id: runId, sessionId: id, state: 'running', startedAt: at, dueAt: at, phase, pendingText: text,
      ...(files.length ? {pendingFiles: files} : {}),
    }],
    sessions: state.sessions.map(session => session.id === id ? {
      ...session, draft: retry || queued ? session.draft : '',
      draftFiles: retry || queued ? session.draftFiles : undefined,
      connectionError: undefined,
      queuedMessages: queued ? session.queuedMessages?.slice(1) : session.queuedMessages,
      queuePaused: session.queuedMessages?.length ? session.queuePaused : undefined,
      messages: [...session.messages, {id: `${runId}-user`, role: 'user', text, at, ...fileFields}],
    } : session),
  };
}
export function rejectNativeSend(state:WorkbenchState,id:string,runId:string,error:string):WorkbenchState {
  const unaccepted = state.runs.find(run => run.id === runId && run.sessionId === id && run.pendingText !== undefined);
  if (!unaccepted) return state;
  return pauseChatQueue({...state,
    runs:state.runs.map(run=>run===unaccepted?{...run,state:'failed',phase:undefined,error}:run),
    sessions:state.sessions.map(session=>session.id===id?{...session,messages:session.messages.filter(message=>message.id!==`${runId}-user`)}:session),
  }, id);
}
export function mergeNativeSession(state: WorkbenchState, native: NativeSession, foreground = true, notify = true): WorkbenchState {
  const space = state.spaces.find(space => space.id === native.workspaceId);
  const old = state.sessions.find(session => session.id === native.id);
  if (!space || (old && old.workspaceId !== native.workspaceId) || (old?.nativeRevision || 0) >= native.revision) return state;
  const visible = foreground && state.activeId === space.id && groups(space.dock.root).some(group => group.activeId === native.id);
  const changed = native.runs.filter(run => ['succeeded', 'failed', 'needs_input', 'interrupted'].includes(run.state) && state.runs.find(old => old.id === run.id)?.state !== run.state);
  const linked=old?old.nodeId:native.nodeId;
  const nodeId=space.nodes.some(n=>n.id===linked)?linked:null;
  const nativeRunIds = new Set(native.runs.map(run => run.id));
  const sending = state.runs.find(run => run.sessionId === native.id && run.state === 'running' && run.pendingText !== undefined && !nativeRunIds.has(run.id));
  const messages = sending?.pendingText !== undefined && !native.messages.some(message => message.id === `${sending.id}-user`)
    ? [...native.messages,{id:`${sending.id}-user`,role:'user' as const,text:sending.pendingText,at:sending.startedAt,
        ...(sending.pendingFiles?.length ? {files:sending.pendingFiles} : {})}] : native.messages;
  const session: AgentSession = {...old, id: native.id, workspaceId: native.workspaceId, nodeId, agentId: native.backend, integrationId: native.backend, title: native.title, messages: reuseMessages(old?.messages||[],messages), draft: old?.draft || '', createdAt: native.createdAt, unread: !visible && (!!changed.length || !!old?.unread), cwd: native.cwd, sourceId: native.sourceId, nativeRevision: native.revision, requests: native.requests, connectionError: native.error || undefined};
  session.effectiveModel = native.effectiveModel ?? undefined;
  session.effectiveEffort = native.effectiveEffort ?? undefined;
  session.queuedMessages = old?.queuedMessages?.filter(item => !nativeRunIds.has(item.id));
  const latest = native.runs.at(-1);
  if (latest && ['failed','cancelled','interrupted'].includes(latest.state) &&
      state.runs.find(run => run.id === latest.id)?.state !== latest.state) session.queuePaused = true;
  const updates = new Map(native.runs.map((run): [string, Run] => [run.id, {
    id: run.id, sessionId: native.id, state: run.state, startedAt: run.startedAt, dueAt: run.finishedAt || run.startedAt,
    error: run.error, context: run.context || undefined, stopping: !!run.cancelRequested && run.state === 'running',
    phase: run.phase, activity: run.activity,
  }]));
  const runs = state.runs.map(run => {
    const update = updates.get(run.id);
    updates.delete(run.id);
    return update ?? run;
  });
  runs.push(...updates.values());
  const notices = [...state.notices]; const artifacts = [...state.artifacts];
  for (const run of changed) {
    const id = `native-${run.id}-${run.state}`;
    if (notify && !visible && !notices.some(notice => notice.id === id)) notices.push({id, runId: run.id, workspaceId: native.workspaceId, sessionId: native.id, title: run.state === 'succeeded' ? '执行完成' : run.state === 'needs_input' ? '需要你的输入' : run.state === 'interrupted' ? '执行中断' : '执行失败', read: false, at: run.finishedAt || Date.now()});
  }
  for (const run of native.runs.filter(run => run.state === 'succeeded')) {
    const id = `native-${run.id}-artifact`;
    if (artifacts.some(artifact => artifact.id === id)) continue;
    const text = native.messages.filter(message => message.role === 'assistant' && message.id.startsWith(`${run.id}-`)).map(message => message.text).join('\n\n');
    if (text.trim()) artifacts.push({id, sessionId: native.id, runId: run.id, title: native.title, text});
  }
  return {...state, sessions: old ? state.sessions.map(s => s.id === native.id ? session : s) : [...state.sessions, session], runs, notices, artifacts};
}
