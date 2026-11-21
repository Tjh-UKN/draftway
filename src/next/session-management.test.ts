import {describe, expect, it} from 'vitest';
import {createSession, initialWorkbench, parseWorkbench, startDemoRun, advanceDemoRuns, placeArtifact, openSession} from './core';
import {deleteSessions, deleteWorkspace, renameSession} from './session-management';
import {mergeBackground} from './background-state';

describe('workspace and session management', () => {
  function fixture() {
    let state = createSession(initialWorkbench(), 'design', 'simplicity', 's', 1);
    state = startDemoRun(state, 's', 'Keep on map', 'succeeded', 'r', 2);
    state = advanceDemoRuns(state, 8000);
    state = placeArtifact(state, state.artifacts[0].id, 5001);
    state.sessions[0].draft = 'Draft';
    return state;
  }
  it('deletes closed and open sessions, references and notices while keeping map artifacts', () => {
    const state = fixture();
    const space = state.spaces[0];
    space.sessionWindow.sessionId = 's';
    space.surfaces.push({id: 'legacy', integrationId: 'session', title: 'Legacy', resourceId: 's'});
    space.layout.panes[0].tabs.push('legacy');
    space.layout.panes[0].activeId = 'legacy';
    const next = deleteSessions(parseWorkbench(state), ['s']);
    expect(next.sessions).toEqual([]); expect(next.runs).toEqual([]); expect(next.artifacts).toEqual([]); expect(next.notices).toEqual([]);
    expect(next.spaces[0].nodes).toEqual(space.nodes);
    expect(next.spaces[0].dock.tabs.some(tab => tab.kind === 'session')).toBe(false);
    expect(next.spaces[0].surfaces.some(surface => surface.id === 'legacy')).toBe(false);
    expect(() => parseWorkbench(JSON.parse(JSON.stringify(next)))).not.toThrow();
    expect(mergeBackground(next, {revision: 1, error: null, reviews: {}, notices: [{id: 'late', workspaceId: 'design', title: 'Late', read: false, at: 1, target: {kind: 'session', sessionId: 's'}}]}).notices).toEqual([]);
  });
  it('rejects running or waiting sessions without partially deleting a workspace', () => {
    const state = startDemoRun(createSession(initialWorkbench(), 'design', null, 's', 1), 's', 'Wait', 'needs_input', 'r', 2);
    expect(() => deleteWorkspace(state, 'design')).toThrow('请先停止');
    state.runs[0].state = 'needs_input';
    expect(() => deleteSessions(state, ['s'])).toThrow('请先停止');
    expect(state.sessions).toHaveLength(1);
  });
  it('renames both session records and tabs without losing messages or drafts', () => {
    const state = fixture(); const next = renameSession(state, 's', '  New name  ');
    expect(next.sessions[0]).toMatchObject({title: 'New name', draft: 'Draft', messages: state.sessions[0].messages});
    expect(next.spaces[0].dock.tabs.find(tab => tab.id === 's')?.title).toBe('New name');
    expect(() => parseWorkbench(next)).not.toThrow();
  });
  it('deletes active and final workspaces, retaining other workspaces and sessions', () => {
    let state = fixture(); state = createSession(state, 'review', null, 'other', 2); state = openSession(state, 's');
    const next = deleteWorkspace(state, 'design');
    expect(next.activeId).not.toBe('design'); expect(next.sessions.map(session => session.id)).toEqual(['other']);
    expect(() => parseWorkbench(next)).not.toThrow();
    let last = next; for (const space of next.spaces) last = deleteWorkspace(last, space.id);
    expect(last.spaces).toHaveLength(1); expect(last.spaces[0].name).toBe('我的工作区'); expect(last.activeId).toBe(last.spaces[0].id);
    expect(() => parseWorkbench(last)).not.toThrow();
  });
});
