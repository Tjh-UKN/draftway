import {useEffect, useRef, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {parseWorkbench, shellStorageKey, type WorkbenchState} from './core';
import type {ChangeState} from './Sessions';

export function durableWorkbench(state: WorkbenchState): WorkbenchState {
  const owned = new Set(state.sessions.filter(session => ['codex', 'claude', 'pi'].includes(session.integrationId)).map(session => session.id));
  return {...state, runs: state.runs.map(run => owned.has(run.sessionId) ? {...run, context: undefined} : run), sessions: state.sessions.map(session => owned.has(session.id) ? {...session, messages: [], requests: [], nativeRevision: undefined} : session), artifacts: state.artifacts.filter(artifact => !owned.has(artifact.sessionId))};
}
export function useWorkbenchPersistence(state: WorkbenchState, change: ChangeState, initialError: string) {
  const native = typeof window !== 'undefined' && isTauri();
  const [ready, setReady] = useState(!native); const [readOnly, setReadOnly] = useState(!!initialError);
  const [error, setError] = useState(initialError); const [saved, setSaved] = useState(false);
  const readyRef = useRef(!native); const readOnlyRef = useRef(!!initialError);
  const serialized = JSON.stringify(native ? durableWorkbench(state) : state);
  const latest = useRef(serialized); latest.current = serialized;
  const queue = useRef<Promise<unknown>>(Promise.resolve()); const written = useRef('');
  const loaded = useRef(state);
  function persist(value: string) {
    if (!readyRef.current || readOnlyRef.current) return;
    if (value === written.current) {setSaved(true); return;}
    const action = queue.current.then(async () => {
      if (native) await invoke('save_shell_state', {snapshot: JSON.parse(value)});
      else localStorage.setItem(shellStorageKey, value);
      written.current = value;
      if (latest.current === value) {setSaved(true); setError('');}
    });
    queue.current = action.catch(error => {setSaved(false); setError(`保存失败：${String(error)}`);});
  }
  async function restore() {
    if (!native) {window.location.reload(); return;}
    readyRef.current = false; setReady(false);
    try {
      const raw = await invoke<unknown>('load_shell_state');
      const next = raw ? parseWorkbench(raw) : loaded.current;
      if (!raw && initialError) throw new Error(initialError);
      change(() => next); readOnlyRef.current = false; setReadOnly(false); setError('');
    } catch (error) {readOnlyRef.current = true; setReadOnly(true); setError(`读取失败，已停止自动覆盖：${String(error)}`);}
    finally {readyRef.current = true; setReady(true);}
  }
  useEffect(() => {if (native) void restore();}, []);
  useEffect(() => {if (!ready || readOnly) return; setSaved(false); const timer = setTimeout(() => persist(serialized), 180); return () => clearTimeout(timer);}, [serialized, ready, readOnly]);
  useEffect(() => {
    const flush = () => persist(latest.current);
    const visibility = () => {if (document.visibilityState === 'hidden') flush();};
    window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', visibility);
    return () => {window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', visibility);};
  }, []);
  return {ready, readOnly, saved, error, retry: () => readOnly ? void restore() : persist(latest.current)};
}
