import {createContext, useContext, useEffect, useRef, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {open as openDialog} from '@tauri-apps/plugin-dialog';
import {mergeNativeSession, type NativeSession} from './agent-state';
import type {AgentSession, WorkbenchState} from './core';
import type {ChangeState} from './Sessions';

export interface BackendState {id: string; available: boolean; detail: string}
export interface AgentRuntime {
  backends: BackendState[]; error: string;
  create: (args: {id: string; workspaceId: string; nodeId: string | null; backend: string; title: string; cwd?: string}) => void;
  send: (session: AgentSession) => void; stop: (id: string) => void; respond: (id: string, requestId: string, answer: unknown) => void;
  chooseDirectory: () => Promise<string | null>;
}
export const AgentRuntimeContext = createContext<AgentRuntime | null>(null);
export const useAgentRuntime = () => useContext(AgentRuntimeContext);
export function useNativeAgents(_state: WorkbenchState, change: ChangeState): AgentRuntime | null {
  const native = typeof window !== 'undefined' && isTauri();
  const [backends, setBackends] = useState<BackendState[]>([]); const [error, setError] = useState('');
  const alive = useRef(true);
  function accept(session: NativeSession) {if (alive.current) change(old => mergeNativeSession(old, session, document.visibilityState === 'visible'));}
  function failure(id: string, error: unknown) {if (alive.current) change(old => ({...old, sessions: old.sessions.map(session => session.id === id ? {...session, connectionError: String(error)} : session)}));}
  useEffect(() => {
    if (!native) return; alive.current = true;
    const listener = listen<NativeSession>('agent-session', ({payload}) => accept(payload));
    void invoke<BackendState[]>('agent_backends').then(value => {if (alive.current) setBackends(value);}).catch(error => {if (alive.current) setError(String(error));});
    void invoke<NativeSession[]>('agent_list').then(sessions => {for (const session of sessions) accept(session);}).catch(error => {if (alive.current) setError(String(error));});
    return () => {alive.current = false; void listener.then(off => off()).catch(() => {});};
  }, [native]);
  if (!native) return null;
  return {backends, error, create(args) {void invoke<NativeSession>('agent_create', {...args, cwd: args.cwd || null}).then(accept).catch(error => failure(args.id, error));},
    send(session) {const runId = crypto.randomUUID(); const text = session.draft.trim(); if (!text) return; change(old => ({...old, sessions: old.sessions.map(s => s.id === session.id ? {...s, draft: '', connectionError: undefined} : s)})); void invoke<NativeSession>('agent_send', {id: session.id, runId, text}).then(accept).catch(error => {failure(session.id, error); change(old => ({...old, sessions: old.sessions.map(s => s.id === session.id && !s.draft ? {...s, draft: text} : s)}));});},
    stop(id) {void invoke<NativeSession>('agent_stop', {id}).then(accept).catch(error => failure(id, error));},
    respond(id, requestId, answer) {void invoke<NativeSession>('agent_respond', {id, requestId, answer}).then(accept).catch(error => failure(id, error));},
    async chooseDirectory() {const value = await openDialog({directory: true, multiple: false, title: '选择工作区目录'}); return typeof value === 'string' ? value : null;}
  };
}
