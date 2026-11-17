import {describe, expect, it} from 'vitest';
import {createSession, initialWorkbench, parseWorkbench, selectWorkspaceTab} from './core';
import {mergeNativeSession, type NativeSession} from './agent-state';

const native = (revision = 1): NativeSession => ({id: 'real', workspaceId: 'design', nodeId: null, backend: 'codex', title: '实际会话', cwd: 'C:\\project', sourceId: 'thread', createdAt: 1, revision, messages: [{id: 'r-item', role: 'assistant', text: '真实结果', at: 2}], runs: [{id: 'r', state: 'succeeded', startedAt: 1, finishedAt: 3, error: null}], requests: [], error: null});
describe('native session projection', () => {
  it('never resurrects a deleted node binding from a later native session snapshot',()=>{
    const initial=createSession(initialWorkbench(),'design',null,'real',1);const payload=native();payload.nodeId='simplicity';
    expect(mergeNativeSession(initial,payload).sessions[0].nodeId).toBeNull();
    payload.nodeId='missing';expect(mergeNativeSession(initialWorkbench(),payload).sessions[0].nodeId).toBeNull();
  });
  it('keeps node identity, drafts and map unchanged while persisting real transcript and source', () => {
    const initial = createSession(initialWorkbench(), 'design', 'link', 'real', 1);
    initial.sessions[0].draft = 'next'; const map = initial.spaces[0].nodes;
    const next = mergeNativeSession(initial, native());
    expect(next.sessions[0]).toMatchObject({integrationId: 'codex', nodeId: 'link', draft: 'next', sourceId: 'thread', unread: false});
    expect(next.spaces[0].nodes).toBe(map); expect(next.artifacts).toHaveLength(1);
    expect(next.notices).toHaveLength(0); expect(parseWorkbench(JSON.parse(JSON.stringify(next)))).toEqual(next);
  });
  it('rejects stale or foreign updates and deduplicates background notices and artifacts', () => {
    let state = selectWorkspaceTab(createSession(initialWorkbench(), 'design', null, 'real', 1), 'design');
    state = mergeNativeSession(state, native());
    expect(state.sessions[0].unread).toBe(true); expect(state.notices).toHaveLength(1);
    expect(mergeNativeSession(state, native())).toBe(state);
    state = mergeNativeSession(state, native(2)); expect(state.notices).toHaveLength(1); expect(state.artifacts).toHaveLength(1);
    expect(mergeNativeSession(state, {...native(3), workspaceId: 'review'})).toBe(state);
  });
  it('never treats failure as an artifact or generates a map node automatically', () => {
    const value = native(); value.runs[0].state = 'failed'; value.runs[0].error = 'Disconnected';
    const state = mergeNativeSession(initialWorkbench(), value, false);
    expect(state.runs[0].state).toBe('failed'); expect(state.runs[0].error).toBe('Disconnected'); expect(state.artifacts).toHaveLength(0);
    expect(state.spaces[0].nodes).toHaveLength(initialWorkbench().spaces[0].nodes.length);
  });
});
