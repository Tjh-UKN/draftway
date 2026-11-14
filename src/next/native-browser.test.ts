import {describe, expect, it} from 'vitest';
import {initialWorkbench, updateWorkspace} from './core';
import {openDockTab} from './docking';
import {applyBrowserPage, browserTabs, clipBrowserSlot} from './native-browser';

describe('native browser host', () => {
  it('keeps inactive workspace browsers alive and excludes blank pages and other content', () => {
    let state = initialWorkbench();
    state = updateWorkspace(state, 'design', space => ({...space, dock: openDockTab(space.dock, {id: 'a', kind: 'browser', title: 'A', url: 'http://localhost:8765/'})}));
    state = updateWorkspace(state, 'review', space => ({...space, dock: openDockTab(space.dock, {id: 'b', kind: 'browser', title: 'B', url: 'https://example.com/'})}));
    state = updateWorkspace(state, 'review', space => ({...space, dock: openDockTab(space.dock, {id: 'blank', kind: 'browser', title: 'New', url: ''})}));
    expect(browserTabs(state).map(tab => tab.id)).toEqual(['a', 'b']);
  });
  it('clips browser bounds to the host viewport and never submits hidden or invalid rectangles', () => {
    expect(clipBrowserSlot('a', {x: -10, y: 100, width: 510, height: 800}, 1280, 720)).toEqual({id: 'a', x: 0, y: 100, width: 500, height: 620});
    for (const rect of [{x: 1300, y: 0, width: 100, height: 100}, {x: 0, y: 0, width: 0, height: 100}, {x: NaN, y: 0, width: 10, height: 10}]) expect(clipBrowserSlot('a', rect, 1280, 720)).toBeNull();
  });
  it('tracks real page navigation without reopening tabs or reviving closed pages', () => {
    let state = initialWorkbench();
    state = updateWorkspace(state, 'design', space => ({...space, dock: openDockTab(space.dock, {id: 'a', kind: 'browser', title: 'A', url: 'http://localhost:8765/'})}));
    const next = applyBrowserPage(state, {id: 'a', title: 'PR 看板', url: 'http://localhost:8765/review/42'});
    expect(browserTabs(next)[0].url).toContain('/review/42');
    expect(next.spaces[0].dock.tabs).toHaveLength(2);
    expect(applyBrowserPage(next, {id: 'a', title: 'PR 看板', url: 'http://localhost:8765/review/42'})).toBe(next);
    expect(applyBrowserPage(next, {id: 'missing', url: 'https://example.com'})).toBe(next);
    expect(applyBrowserPage(next, {id: 'a', url: 'javascript:alert(1)'})).toBe(next);
  });
});
