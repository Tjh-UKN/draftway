import {useEffect, useRef, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {updateWorkspace, type WorkbenchState} from './core';
import {browserUrl, groups, openDockTab} from './docking';
import type {ChangeState} from './Sessions';

export const nativeBrowserEnabled = typeof window !== 'undefined' && isTauri();
export interface BrowserStatus {ready?: boolean; error?: string; back?: boolean; forward?: boolean; loading?: boolean}
export interface NativeBrowserHost {statuses: Record<string, BrowserStatus>; action: (id: string, action: 'back' | 'forward' | 'reload') => void; external: (url: string) => void}
export interface BrowserSnapshot {tabs: {id: string; url: string}[]; slots: {id: string; x: number; y: number; width: number; height: number}[]; viewportWidth: number; viewportHeight: number}
interface BrowserPageEvent {id: string; url?: string | null; title?: string; loading?: boolean}
export function applyBrowserPage(state: WorkbenchState, event: BrowserPageEvent): WorkbenchState {
  const owner = state.spaces.find(space => space.dock.tabs.some(tab => tab.id === event.id && tab.kind === 'browser'));
  if (!owner) return state;
  const tab = owner.dock.tabs.find(tab => tab.id === event.id)!;
  if (tab.kind !== 'browser') return state;
  const url = event.url ? browserUrl(event.url) || tab.url : tab.url;
  const title = event.title?.trim() ? event.title.slice(0, 200) : tab.title;
  if (tab.url === url && tab.title === title) return state;
  return updateWorkspace(state, owner.id, space => ({...space, dock: {...space.dock, tabs: space.dock.tabs.map(item => item.id === tab.id ? {...tab, url, title} : item)}}));
}
// The same tab keeps the same native view across React reparenting and workspace switches.
let bridge: Promise<unknown> = Promise.resolve();
function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = bridge.then(() => invoke<T>(name, args));
  bridge = result.catch(() => undefined); return result;
}
export function browserTabs(state: WorkbenchState) {
  return state.spaces.flatMap(space => space.dock.tabs.flatMap(tab => tab.kind === 'browser' && tab.url ? [{id: tab.id, url: tab.url}] : []));
}
export function clipBrowserSlot(id: string, rect: {x: number; y: number; width: number; height: number}, width: number, height: number) {
  const x = Math.max(0, rect.x); const y = Math.max(0, rect.y);
  const w = Math.min(width, rect.x + rect.width) - x; const h = Math.min(height, rect.y + rect.height) - y;
  return [x, y, w, h].every(Number.isFinite) && w >= 1 && h >= 1 ? {id, x, y, width: w, height: h} : null;
}
export function useNativeBrowserHost(state: WorkbenchState, change: ChangeState, enabled = true): NativeBrowserHost | null {
  const current = useRef(state); current.current = state;
  const schedule = useRef<() => void>(() => {});
  const retry = useRef<() => void>(() => {});
  const [statuses, setStatuses] = useState<Record<string, BrowserStatus>>({});
  useEffect(() => {schedule.current();}, [state]);
  useEffect(() => {
    if (!nativeBrowserEnabled || !enabled) return;
    let alive = true; let frame = 0; let busy = false; let dirty = false; let previous = '';
    const observed = new Set<Element>();
    function patch(id: string, update: BrowserStatus) {if (alive) setStatuses(all => {const next = {...all[id], ...update}; return JSON.stringify(next) === JSON.stringify(all[id]) ? all : {...all, [id]: next};});}
    function snapshot(): BrowserSnapshot {
      const width = innerWidth; const height = innerHeight;
      const blocked = document.visibilityState === 'hidden' || !!document.querySelector('[role="menu"], dialog[open], .workspace-session-panel, .notification-panel, .is-dragging, .resizing-panes');
      const slots: BrowserSnapshot['slots'] = [];
      const elements = [...document.querySelectorAll<HTMLElement>('[data-native-browser-id]')];
      for (const old of observed) if (!elements.includes(old as HTMLElement)) {observer.unobserve(old); observed.delete(old);}
      for (const element of elements) {
        if (!observed.has(element)) {observer.observe(element); observed.add(element);}
        if (blocked || !element.getClientRects().length) continue;
        const slot = clipBrowserSlot(element.dataset.nativeBrowserId!, element.getBoundingClientRect(), width, height);
        if (slot) slots.push(slot);
      }
      return {tabs: browserTabs(current.current), slots, viewportWidth: width, viewportHeight: height};
    }
    async function sync() {
      frame = 0; if (!alive) return;
      if (busy) {dirty = true; return;}
      const next = snapshot(); const signature = JSON.stringify(next);
      if (signature === previous) return;
      busy = true; previous = signature;
      try {
        const results = await call<{id: string; error: string | null}[]>('sync_browser_views', {snapshot: next});
        for (const result of results) patch(result.id, {ready: !result.error, error: result.error || undefined});
      } catch (error) {previous = ''; for (const tab of next.tabs) patch(tab.id, {ready: false, error: String(error)});}
      finally {busy = false; if (dirty && alive) {dirty = false; schedule.current();}}
    }
    schedule.current = () => {if (alive && !frame) frame = requestAnimationFrame(() => {void sync();});};
    retry.current = () => {previous = ''; schedule.current();};
    const observer = new ResizeObserver(() => schedule.current());
    const mutations = new MutationObserver(() => schedule.current());
    mutations.observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class', 'style']});
    const layout = () => schedule.current();
    window.addEventListener('resize', layout); document.addEventListener('visibilitychange', layout); document.addEventListener('scroll', layout, true);
    const page = listen<BrowserPageEvent>('browser-page', ({payload}) => {
      if (!alive || !browserTabs(current.current).some(tab => tab.id === payload.id)) return;
      if (typeof payload.loading === 'boolean') patch(payload.id, {loading: payload.loading});
      change(old => applyBrowserPage(old, payload));
    });
    const popup = listen<{id: string; url: string}>('browser-new-tab', ({payload}) => {
      const url = browserUrl(payload.url); if (!alive || !url) return; const id = crypto.randomUUID();
      change(old => {
        const owner = old.spaces.find(space => space.dock.tabs.some(tab => tab.id === payload.id && tab.kind === 'browser'));
        const group = owner && groups(owner.dock.root).find(group => group.tabs.includes(payload.id));
        if (!owner || !group || owner.id !== old.activeId || group.activeId !== payload.id || browserTabs(old).length >= 64) return old;
        return {...updateWorkspace(old, owner.id, space => ({...space, dock: openDockTab(space.dock, {id, kind: 'browser', title: new URL(url).host, url}, group.id)})), activeId: owner.id};
      });
    });
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      const ids = snapshot().slots.map(slot => slot.id); if (!ids.length || busy) return;
      void call<({id: string; url?: string} & BrowserStatus)[]>('browser_history', {ids}).then(results => {for (const {id, url, ...status} of results) {patch(id, status); if (alive && url) change(old => applyBrowserPage(old, {id, url}));}}).catch(() => {});
    }, 1000);
    schedule.current();
    return () => {
      alive = false; cancelAnimationFrame(frame); clearInterval(interval); observer.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', layout); document.removeEventListener('visibilitychange', layout); document.removeEventListener('scroll', layout, true);
      void page.then(off => off()); void popup.then(off => off());
      void call('sync_browser_views', {snapshot: {tabs: browserTabs(current.current), slots: [], viewportWidth: innerWidth, viewportHeight: innerHeight}}).catch(() => {});
    };
  }, [change, enabled]);
  if (!nativeBrowserEnabled) return null;
  return {statuses, action(id, action) {if (action === 'reload' && !statuses[id]?.ready) {retry.current(); return;} void call('browser_action', {id, action}).catch(error => setStatuses(all => ({...all, [id]: {...all[id], ready: false, error: String(error)}})));}, external(url) {void call('open_external_url', {url}).catch(error => {for (const tab of browserTabs(current.current).filter(tab => tab.url === url)) setStatuses(all => ({...all, [tab.id]: {...all[tab.id], error: String(error)}}));});}};
}
