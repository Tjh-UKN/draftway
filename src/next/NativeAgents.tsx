import {canStartQueuedMessage, pauseChatQueue, useChatQueue, type ChatSend} from './chat-queue';
import type {ChatFile} from './session-files';
import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {open as openDialog} from '@tauri-apps/plugin-dialog';
import {beginNativeSend,mergeNativeSession,rejectNativeSend, type NativeSession} from './agent-state';
import type {WorkbenchState} from './core';
import type {ChangeState} from './Sessions';
import {agentNames} from './integrations';
import {SessionTranscripts,type TranscriptFrame} from './session-transcript';

export interface BackendState {id: string; available: boolean; detail: string}
export interface AgentModelOption {
  id: string;
  model: string;
  displayName: string;
  supportedReasoningEfforts: {reasoningEffort: string; description: string}[];
  defaultReasoningEffort: string;
  isDefault: boolean;
}
export interface AgentModelOptions {models: AgentModelOption[]; model: string | null; effort: string | null}
const modelOptions = (id: string) => invoke<AgentModelOptions>('agent_model_options', {id});
export function modelCatalogDirectory(cwd: string) {
  if (!/^[a-z]:[\\/]|^\\\\|^\/\//i.test(cwd)) return cwd;
  return cwd.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
}
type BackendScan = {status: 'idle' | 'checking' | 'ready' | 'failed'; message?: string};
export interface AgentRuntime {
  readOnly?:boolean;
  backends: BackendState[]; error: string;
  backendScan: BackendScan;
  refreshBackends: () => Promise<void>;
  modelOptions: (id: string) => Promise<AgentModelOptions>;
  prefetchModelOptions: (backend: string, workspaceId: string, cwd?: string, signal?: AbortSignal) => Promise<void>;
  transcripts?:SessionTranscripts;
  create: (args: {id: string; workspaceId: string; nodeId: string | null; backend: string; title: string; cwd?: string}) => void;
  send: ChatSend; stop: (id: string) => void; respond: (id: string, requestId: string, answer: unknown) => void;
  chooseDirectory: () => Promise<string | null>;
  remove: (ids: string[], workspaceId?: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
}
export const AgentRuntimeContext = createContext<AgentRuntime | null>(null);
export const useAgentRuntime = () => useContext(AgentRuntimeContext);
export function useNativeAgents(_state: WorkbenchState, change: ChangeState, enabled = true,workspaceVisible=true,queueEnabled=true): AgentRuntime | null {
  const native = typeof window !== 'undefined' && isTauri();
  const [backends, setBackends] = useState<BackendState[]>([]); const [error, setError] = useState('');
  const [backendScan, setBackendScan] = useState<BackendScan>({status: 'idle'});
  const backendRequest = useRef<Promise<void> | null>(null);
  const catalogRequests = useRef(new Map<string, Promise<void>>());
  const alive = useRef(true);
  const [transcripts]=useState(()=>new SessionTranscripts());
  const visible=useRef(workspaceVisible);visible.current=workspaceVisible;
  const pendingSends=useRef(new Set<string>());
  const [sendSettled,setSendSettled]=useState(0);
  const currentState=useRef(_state);
  currentState.current=_state;
  const pendingCreates = useRef(new Map<string, Promise<unknown>>());
  const deleted = useRef(new Set<string>());
  const accept = useCallback((session: NativeSession) => {
    if (!alive.current || deleted.current.has(session.id)) return;
    const messages = transcripts.replace(session.id, session.revision, session.messages);
    change(old => deleted.current.has(session.id) ? old : mergeNativeSession(old, {...session, messages}, visible.current && document.visibilityState === 'visible' && document.hasFocus(), false));
  }, [change, transcripts]);
  const failure=useCallback((id: string, error: unknown) => {if (alive.current) change(old => ({...old, sessions: old.sessions.map(session => session.id === id ? {...session, connectionError: String(error)} : session)}));},[change]);
  const refreshBackends = useCallback(() => {
    if (backendRequest.current) return backendRequest.current;
    setBackendScan({status: 'checking'});
    const request = invoke<BackendState[]>('agent_backends').then(value => {
      if (!alive.current) return;
      setBackends(value);
      setBackendScan({status: 'ready'});
    }).catch(error => {
      if (alive.current) setBackendScan({status: 'failed', message: String(error)});
    }).finally(() => {backendRequest.current = null;});
    backendRequest.current = request;
    return request;
  }, []);
  const prefetchModelOptions = useCallback(async (backend: string, workspaceId: string, cwd?: string, signal?: AbortSignal) => {
    const key = JSON.stringify(cwd ? [backend, modelCatalogDirectory(cwd)] : [backend, null, workspaceId]);
    const requests = catalogRequests.current;
    while (!signal?.aborted) {
      const active = requests.get(key);
      if (active) return active;
      if (requests.size < 2) break;
      await Promise.race(requests.values());
    }
    if (signal?.aborted) return;
    const request = invoke<void>('agent_prefetch_model_options', {backend, workspaceId, cwd: cwd ?? null})
      .catch(() => {})
      .finally(() => requests.delete(key));
    requests.set(key, request);
    return request;
  }, []);
  useEffect(() => {
    if (!native || !enabled) return; alive.current = true;
    const restoredIds=_state.sessions.filter(s=>Object.hasOwn(agentNames, s.integrationId)).map(s=>s.id);let initial=true;
    const listener = listen<NativeSession>('agent-session', ({payload}) => accept(payload));
    const recovering=new Set<string>();
    const streaming=listen<TranscriptFrame>('agent-transcript',({payload})=>{
      if(!alive.current||deleted.current.has(payload.id)||transcripts.apply(payload)||recovering.has(payload.id))return;
      recovering.add(payload.id);
      void invoke<NativeSession>('agent_get',{id:payload.id}).then(accept).catch(error=>failure(payload.id,error)).finally(()=>recovering.delete(payload.id));
    });
    void refreshBackends();
    const refresh = () => {void invoke<NativeSession[]>('agent_list').then(sessions => {for (const session of sessions) accept(session);if(initial){initial=false;for(const id of restoredIds.filter(id=>!sessions.some(s=>s.id===id)))failure(id,'本机没有此会话日志。请从包含会话的完整备份恢复，或新建会话。');}}).catch(error => {if (alive.current) setError(String(error));});};
    void Promise.all([listener,streaming]).then(refresh).catch(error => {if (alive.current) setError(String(error));}); window.addEventListener('focus', refresh);
    return () => {alive.current = false;transcripts.clear(); window.removeEventListener('focus', refresh);for(const listening of [listener,streaming])void listening.then(off => off()).catch(() => {});};
  }, [native, enabled,accept,failure,transcripts,refreshBackends]);
  const runtime=useMemo<AgentRuntime>(()=>({backends, backendScan, refreshBackends, modelOptions, prefetchModelOptions, error, transcripts,
    create(args) {
      const pending = invoke<NativeSession>('agent_create', {...args, cwd: args.cwd || null}).then(accept)
        .catch(error => failure(args.id, error)).finally(() => pendingCreates.current.delete(args.id));
      pendingCreates.current.set(args.id, pending);
    },
    async remove(ids, workspaceId) {
      await Promise.all(pendingCreates.current.values());
      const removed = await invoke<string[]>('agent_delete', {ids, workspaceId: workspaceId ?? null});
      for (const id of new Set([...ids, ...removed])) {
        deleted.current.add(id);
        transcripts.remove(id);
      }
    },
    async rename(id, title) {
      accept(await invoke<NativeSession>('agent_rename', {id, title}));
    },
    send(session, request) {
      const text = request?.text ?? session.draft;
      const files = request ? request.files ?? [] : session.draftFiles ?? [];
      const queued = request?.queued === true;
      const runId = request?.id ?? crypto.randomUUID();
      const active = currentState.current.runs.some(run =>
        run.sessionId === session.id && (run.state === 'running' || run.state === 'needs_input'));
      if ((!text.trim() && !files.length) || pendingSends.current.has(session.id) || active ||
          (queued && !canStartQueuedMessage(currentState.current, session.id, runId))) return false;
      if (request && !queued && !currentState.current.runs.some(run =>
        run.id === runId && run.sessionId === session.id && run.state === 'failed' && run.pendingText === text)) return false;
      pendingSends.current.add(session.id);
      const at = Date.now();
      change(old => beginNativeSend(old, session.id, runId, text, at, !!request && !queued, files, queued));
      const args: {id: string; runId: string; text: string; files?: ChatFile[]; model?: string; effort?: string} = {id: session.id, runId, text};
      if (files.length) args.files = files;
      if (Object.hasOwn(agentNames, session.integrationId)) {
        if (session.selectedModel) args.model = session.selectedModel;
        if (session.selectedEffort) args.effort = session.selectedEffort;
      }
      void invoke<NativeSession>('agent_send', args).then(accept).catch(error => {
        if (alive.current) change(old => rejectNativeSend(old, session.id, runId, String(error)));
      }).finally(() => {
        pendingSends.current.delete(session.id);
        if (alive.current) setSendSettled(count => count + 1);
      });
      return true;
    },
    stop(id) {
      change(old => pauseChatQueue(old, id));
      void invoke<NativeSession>('agent_stop', {id}).then(accept).catch(error => failure(id, error));
    },
    respond(id, requestId, answer) {void invoke<NativeSession>('agent_respond', {id, requestId, answer}).then(accept).catch(error => failure(id, error));},
    async chooseDirectory() {const value = await openDialog({directory: true, multiple: false, title: '选择工作区目录'}); return typeof value === 'string' ? value : null;}
  }),[backends,backendScan,refreshBackends,prefetchModelOptions,error,transcripts,accept,failure,change]);
  useChatQueue(_state,native && enabled && queueEnabled,runtime.send,sendSettled);
  return native?runtime:null;
}
