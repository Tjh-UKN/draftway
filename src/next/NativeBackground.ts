import {useEffect, useRef, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {mergeBackground, type BackgroundState} from './background-state';
import type {Notice, WorkbenchState} from './core';
import type {ChangeState} from './Sessions';

export function useNativeBackground(state: WorkbenchState, change: ChangeState, enabled: boolean, onOpen: (notice: Notice) => void) {
  const [snapshot, setSnapshot] = useState<BackgroundState>({revision: -1, error: null, notices: [], reviews: {}});
  const [error, setError] = useState(''); const revision = useRef(-1); const acked = useRef(new Set<string>());
  const [retry, setRetry] = useState(0);
  const current = useRef({state, onOpen}); current.current = {state, onOpen};
  useEffect(() => {
    if (!enabled || !isTauri()) return; let alive = true;
    const accept = (value: BackgroundState) => {if (alive && value.revision > revision.current) {revision.current = value.revision; setSnapshot(value); setError(value.error || ''); change(old => mergeBackground(old, value));}};
    const refresh = () => {void invoke<BackgroundState>('background_snapshot').then(accept).catch(e => {if (alive) setError(String(e));});};
    const events = listen<BackgroundState>('background-state', event => accept(event.payload));
    const clicks = listen<string>('notice-activate', event => {void invoke<BackgroundState>('background_snapshot').then(value => {accept(value); const notice = value.notices.find(n => n.id === event.payload); if (alive && notice) current.current.onOpen(notice);}).catch(e => {if (alive) setError(String(e));});});
    void events.then(refresh).catch(e => {if (alive) setError(String(e));});
    const visible = () => {if (document.visibilityState === 'visible') refresh();};
    document.addEventListener('visibilitychange', visible); window.addEventListener('focus', refresh);
    return () => {alive = false; void events.then(off => off()).catch(() => {}); void clicks.then(off => off()).catch(() => {}); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', refresh);};
  }, [enabled, change]);
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    const ids = snapshot.notices.filter(n => !n.read && state.notices.some(old => old.id === n.id && old.read) && !acked.current.has(n.id)).map(n => n.id);
    if (!ids.length) return; ids.forEach(id => acked.current.add(id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    void invoke('background_read', {ids}).catch(e => {ids.forEach(id => acked.current.delete(id)); setError(String(e)); timer = setTimeout(() => setRetry(value => value + 1), 30000);});
    return () => {if (timer) clearTimeout(timer);};
  }, [state.notices, snapshot, enabled, retry]);
  return {reviews: snapshot.reviews, error};
}
