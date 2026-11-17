import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {open as openDialog} from '@tauri-apps/plugin-dialog';
import {beginNativeSend,mergeNativeSession,rejectNativeSend, type NativeSession} from './agent-state';
import type {AgentSession, WorkbenchState} from './core';
import type {ChangeState} from './Sessions';
import {SessionTranscripts,type TranscriptFrame} from './session-transcript';

export interface BackendState {id: string; available: boolean; detail: string}
export interface AgentRuntime {
  readOnly?:boolean;
  backends: BackendState[]; error: string;
  transcripts?:SessionTranscripts;
  create: (args: {id: string; workspaceId: string; nodeId: string | null; backend: string; title: string; cwd?: string}) => void;
  send: (session: AgentSession) => void; stop: (id: string) => void; respond: (id: string, requestId: string, answer: unknown) => void;
  chooseDirectory: () => Promise<string | null>;
}
export const AgentRuntimeContext = createContext<AgentRuntime | null>(null);
export const useAgentRuntime = () => useContext(AgentRuntimeContext);
export function useNativeAgents(_state: WorkbenchState, change: ChangeState, enabled = true,workspaceVisible=true): AgentRuntime | null {
  const native = typeof window !== 'undefined' && isTauri();
  const [backends, setBackends] = useState<BackendState[]>([]); const [error, setError] = useState('');
  const alive = useRef(true);
  const [transcripts]=useState(()=>new SessionTranscripts());
  const visible=useRef(workspaceVisible);visible.current=workspaceVisible;
  const pendingSends=useRef(new Set<string>());
  const accept=useCallback((session: NativeSession) => {if (alive.current) {const messages=transcripts.replace(session.id,session.revision,session.messages);change(old => mergeNativeSession(old, {...session,messages}, visible.current && document.visibilityState === 'visible' && document.hasFocus(), false));}},[change,transcripts]);
  const failure=useCallback((id: string, error: unknown) => {if (alive.current) change(old => ({...old, sessions: old.sessions.map(session => session.id === id ? {...session, connectionError: String(error)} : session)}));},[change]);
  useEffect(() => {
    if (!native || !enabled) return; alive.current = true;
    const restoredIds=_state.sessions.filter(s=>['codex','claude','pi'].includes(s.integrationId)).map(s=>s.id);let initial=true;
    const listener = listen<NativeSession>('agent-session', ({payload}) => accept(payload));
    const recovering=new Set<string>();
    const streaming=listen<TranscriptFrame>('agent-transcript',({payload})=>{
      if(!alive.current||transcripts.apply(payload)||recovering.has(payload.id))return;
      recovering.add(payload.id);
      void invoke<NativeSession>('agent_get',{id:payload.id}).then(accept).catch(error=>failure(payload.id,error)).finally(()=>recovering.delete(payload.id));
    });
    void invoke<BackendState[]>('agent_backends').then(value => {if (alive.current) setBackends(value);}).catch(error => {if (alive.current) setError(String(error));});
    const refresh = () => {void invoke<NativeSession[]>('agent_list').then(sessions => {for (const session of sessions) accept(session);if(initial){initial=false;for(const id of restoredIds.filter(id=>!sessions.some(s=>s.id===id)))failure(id,'本机没有此会话日志。请从包含会话的完整备份恢复，或新建会话。');}}).catch(error => {if (alive.current) setError(String(error));});};
    void Promise.all([listener,streaming]).then(refresh).catch(error => {if (alive.current) setError(String(error));}); window.addEventListener('focus', refresh);
    return () => {alive.current = false;transcripts.clear(); window.removeEventListener('focus', refresh);for(const listening of [listener,streaming])void listening.then(off => off()).catch(() => {});};
  }, [native, enabled,accept,failure,transcripts]);
  const runtime=useMemo<AgentRuntime>(()=>({backends, error,transcripts, create(args) {void invoke<NativeSession>('agent_create', {...args, cwd: args.cwd || null}).then(accept).catch(error => failure(args.id, error));},
    send(session) {const runId = crypto.randomUUID(); const text = session.draft; if (!text.trim() || pendingSends.current.has(session.id)) return;pendingSends.current.add(session.id);const at=Date.now();change(old=>beginNativeSend(old,session.id,runId,text,at));void invoke<NativeSession>('agent_send', {id: session.id, runId, text}).then(accept).catch(error=>{if(alive.current)change(old=>rejectNativeSend(old,session.id,runId,text,session.nativeRevision,String(error)));}).finally(()=>pendingSends.current.delete(session.id));},
    stop(id) {void invoke<NativeSession>('agent_stop', {id}).then(accept).catch(error => failure(id, error));},
    respond(id, requestId, answer) {void invoke<NativeSession>('agent_respond', {id, requestId, answer}).then(accept).catch(error => failure(id, error));},
    async chooseDirectory() {const value = await openDialog({directory: true, multiple: false, title: '选择工作区目录'}); return typeof value === 'string' ? value : null;}
  }),[backends,error,transcripts,accept,failure,change]);
  return native?runtime:null;
}
