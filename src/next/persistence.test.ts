import {describe, expect, it} from 'vitest';
import {createSession, initialWorkbench, parseWorkbench} from './core';
import {durableWorkbench} from './persistence';
import {mergeNativeSession, type NativeSession} from './agent-state';

describe('durable workspace snapshot', () => {
  it('keeps UI and drafts while native transcripts remain authoritative in SQLite', () => {
    let state = createSession(initialWorkbench(), 'design', null, 'real', 1);
    state.sessions[0].draft = 'next draft';
    const source: NativeSession = {id:'real', workspaceId:'design', nodeId:null, backend:'codex', title:'Real', cwd:'C:/project', sourceId:'thread', createdAt:1, revision:4, messages:[{id:'r-final',role:'assistant',text:'Saved by native host',at:2}], runs:[{id:'r',state:'succeeded',startedAt:1,finishedAt:3,error:null}], requests:[], error:null};
    state = mergeNativeSession(state, source);
    const restored = parseWorkbench(JSON.parse(JSON.stringify(durableWorkbench(state))));
    expect(restored.sessions[0].messages).toEqual([]); expect(restored.sessions[0].draft).toBe('next draft'); expect(restored.sessions[0].nativeRevision).toBeUndefined();
    const hydrated = mergeNativeSession(restored, source); expect(hydrated.sessions[0].messages).toEqual(source.messages); expect(hydrated.artifacts[0].text).toBe('Saved by native host'); expect(hydrated.spaces[0].dock).toEqual(state.spaces[0].dock);
  });
  it('preserves simulated and unknown-provider conversations instead of stripping their only copy', () => {
    const state = createSession(initialWorkbench(), 'design', null, 'demo', 1); state.sessions[0].messages.push({id:'m',role:'user',text:'Keep this',at:1});
    expect(durableWorkbench(state).sessions[0].messages).toEqual(state.sessions[0].messages);
    state.sessions[0].integrationId='unknown-provider'; expect(durableWorkbench(state).sessions[0].messages).toEqual(state.sessions[0].messages);
  });
});
