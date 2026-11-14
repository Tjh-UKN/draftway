import {describe, expect, it} from 'vitest';
import {advanceDemoRuns, closeSessionTab, createSession, initialWorkbench, openSession, parseWorkbench, startDemoRun, updateWorkspace} from './core';
import {browserUrl, closeDockTab, closeEmptyGroup, focusedGroup, groups, initialDock, mergeDock, moveDockTab, openDockTab, resizeDock, selectDockTab, splitDockGroup, validateDock} from './docking';
import {readReviewFile, reviewLines} from './ToolViews';

describe('workspace pane tree', () => {
  const browser = {id: 'browser', kind: 'browser' as const, title: 'Browser', url: 'http://localhost:8765/'};
  it('nests horizontal and vertical splits with exactly one owner for each tab', () => {
    let dock = openDockTab(initialDock(), browser);
    dock = moveDockTab(dock, 'browser', 'main', undefined, 'right', 'right');
    dock = openDockTab(dock, {id: 'review', kind: 'review', title: 'Review', files: []});
    dock = moveDockTab(dock, 'review', 'right', undefined, 'bottom', 'bottom');
    expect(dock.root.kind).toBe('split');
    expect(groups(dock.root).map(g => g.tabs)).toEqual([['workspace'], ['browser'], ['review']]);
    expect(() => validateDock(dock, [])).not.toThrow();
    const resized = resizeDock(dock, 'split-right', .63);
    expect(resized.root).toMatchObject({ratio: .63});
    expect(resizeDock(resized, 'split-right', 4).root).toMatchObject({ratio: .85});
  });
  it('moves and reorders tabs, pruning empty branches and retaining the map', () => {
    let dock = openDockTab(initialDock(), browser);
    dock = moveDockTab(dock, 'browser', 'main', undefined, 'right', 'right');
    dock = moveDockTab(dock, 'workspace', 'right', 'browser');
    expect(groups(dock.root)).toHaveLength(1);
    expect(groups(dock.root)[0].tabs).toEqual(['workspace', 'browser']);
    dock = moveDockTab(dock, 'browser', 'right', 'workspace');
    expect(groups(dock.root)[0].tabs).toEqual(['browser', 'workspace']);
    expect(closeDockTab(dock, 'workspace')).toBe(dock);
    expect(closeDockTab(dock, 'browser').tabs.map(t => t.id)).toEqual(['workspace']);
  });
  it('splits the first map into an empty pane and opens content directly in that pane', () => {
    let dock = splitDockGroup(initialDock(), 'main', 'column', 'bottom');
    expect(focusedGroup(dock).tabs).toEqual([]);
    expect(() => validateDock(dock, [])).not.toThrow();
    dock = openDockTab(dock, browser);
    expect(focusedGroup(dock).tabs).toEqual(['browser']);
    expect(mergeDock(dock).root).toMatchObject({tabs: ['workspace', 'browser'], activeId: 'browser'});
    const empty = splitDockGroup(initialDock(), 'main', 'row', 'empty');
    expect(groups(closeEmptyGroup(empty, 'empty').root)).toHaveLength(1);
  });
  it('closes a pane to the last used surviving tab without stopping an agent', () => {
    let state = createSession(initialWorkbench(), 'design', null, 'agent', 0);
    state = startDemoRun(state, 'agent', 'Keep running', 'succeeded', 'run', 0);
    state = updateWorkspace(state, 'design', w => ({...w, dock: moveDockTab(w.dock, 'agent', 'main', undefined, 'right', 'right')}));
    state = closeSessionTab(state, 'design', 'agent');
    expect(state.runs[0].state).toBe('running');
    expect(groups(state.spaces[0].dock.root)).toHaveLength(1);
    state = advanceDemoRuns(state, 8000);
    expect(state.sessions[0].unread).toBe(true);
    state = openSession(state, 'agent');
    state = openSession(state, 'agent');
    expect(state.spaces[0].dock.tabs.filter(t => t.id === 'agent')).toHaveLength(1);
    expect(state.sessions[0].unread).toBe(false);
  });
  it('keeps MRU selection in the correct group and ignores invalid drag targets', () => {
    let dock = openDockTab(initialDock(), browser);
    dock = openDockTab(dock, {id: 'r', kind: 'review', title: 'Review', files: []});
    dock = selectDockTab(dock, 'browser');
    expect(focusedGroup(closeDockTab(dock, 'browser')).activeId).toBe('r');
    expect(moveDockTab(dock, 'missing', 'main')).toBe(dock);
    expect(moveDockTab(dock, 'browser', 'missing')).toBe(dock);
    expect(moveDockTab(initialDock(), 'workspace', 'main', undefined, 'right')).toEqual(initialDock());
  });
  it('migrates existing session tabs and restores split ratios, browser URLs and file snapshots', () => {
    const raw = JSON.parse(JSON.stringify(createSession(initialWorkbench(), 'design', null, 'agent', 0)));
    delete raw.spaces[0].dock;
    const before = JSON.stringify(raw);
    let state = parseWorkbench(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(focusedGroup(state.spaces[0].dock).activeId).toBe('agent');
    state = updateWorkspace(state, 'design', w => ({...w, dock: openDockTab(w.dock, browser)}));
    state = updateWorkspace(state, 'design', w => ({...w, dock: moveDockTab(w.dock, 'browser', 'main', undefined, 'right', 'right')}));
    state = updateWorkspace(state, 'design', w => ({...w, dock: resizeDock(w.dock, 'split-right', .61)}));
    state = updateWorkspace(state, 'design', w => ({...w, dock: openDockTab(w.dock, {id: 'r', kind: 'review', title: 'File', files: [{name: 'x.ts', text: 'const x = 1;'}]})}));
    expect(parseWorkbench(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
  it('rejects corrupt trees, duplicate ownership, unsafe URLs and foreign sessions', () => {
    const state = createSession(initialWorkbench(), 'design', null, 'agent', 0);
    for (const mutate of [
      (d: ReturnType<typeof initialDock>) => {groups(d.root)[0].tabs.push('agent');},
      (d: ReturnType<typeof initialDock>) => {d.activeGroupId = 'missing';},
      (d: ReturnType<typeof initialDock>) => {d.tabs.push({id: 'bad', kind: 'session', title: 'Bad', sessionId: 'other-workspace'}); groups(d.root)[0].tabs.push('bad');},
      (d: ReturnType<typeof initialDock>) => {d.tabs.push({...browser, url: 'javascript:alert(1)'}); groups(d.root)[0].tabs.push('browser');},
    ]) {const raw = structuredClone(state); mutate(raw.spaces[0].dock); expect(() => parseWorkbench(raw)).toThrow();}
  });
  it('limits pane count while allowing new tabs within the focused pane', () => {
    let dock = initialDock();
    for (let i = 0; i < 7; i++) dock = splitDockGroup(dock, dock.activeGroupId, i % 2 ? 'row' : 'column', `g${i}`);
    expect(groups(dock.root)).toHaveLength(8);
    expect(splitDockGroup(dock, dock.activeGroupId, 'row')).toBe(dock);
    expect(openDockTab(dock, browser).tabs).toHaveLength(2);
  });
  it('closing an empty group preserves other deliberately empty groups', () => {
    let dock = splitDockGroup(initialDock(), 'main', 'row', 'empty1');
    dock = splitDockGroup(dock, 'empty1', 'column', 'empty2');
    dock = closeEmptyGroup(dock, 'empty2');
    expect(groups(dock.root).map(g => g.id)).toEqual(['main', 'empty1']);
    expect(() => validateDock(dock, [])).not.toThrow();
  });
});
describe('browser and read-only file review', () => {
  it('normalizes ordinary and local addresses and rejects executable schemes and credentials', () => {
    expect(browserUrl('localhost:8765')).toBe('http://localhost:8765/');
    expect(browserUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(browserUrl('')).toBe('');
    for (const url of ['javascript:alert(1)', 'file:///C:/x', 'data:text/html,hi', 'https://user:secret@example.com']) expect(browserUrl(url)).toBeNull();
  });
  it('computes actual inserted and removed lines without hiding whitespace changes', () => {
    const diff = reviewLines([{name: 'before.ts', text: 'a\r\nb\r\n'}, {name: 'after.ts', text: 'a\nc\n'}])!;
    expect(diff.find(d => d.removed)?.value.trim()).toBe('b');
    expect(diff.find(d => d.added)?.value.trim()).toBe('c');
    expect(reviewLines([{name: 'x', text: ''}])).toBeNull();
    expect(reviewLines([{name: 'x', text: 'a\n'}, {name: 'y', text: ' a\n'}])?.some(d => d.added)).toBe(true);
  });
  it('reads bounded text files and rejects binary/oversized input', async () => {
    expect(await readReviewFile(new File(['const x = 1;'], 'x.ts'))).toEqual({name: 'x.ts', text: 'const x = 1;'});
    await expect(readReviewFile(new File(['a\0b'], 'binary'))).rejects.toThrow();
    await expect(readReviewFile(new File(['x'.repeat(262145)], 'large'))).rejects.toThrow();
  });
});

import {repairBrowserIds} from './docking';
it('migrates unsafe browser IDs without losing their pane or history order',()=>{const dock=openDockTab(initialDock(),{id:'dashboard:http://localhost:8765/',kind:'browser',url:'http://localhost:8765/',title:'Review'});const next=repairBrowserIds(dock,new Set(),()=>'safe-id');expect(next.tabs.find(t=>t.kind==='browser')?.id).toBe('safe-id');expect(next.recent.at(-1)).toBe('safe-id');expect(focusedGroup(next).activeId).toBe('safe-id');validateDock(next,[]);});
