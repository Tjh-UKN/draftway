import {describe, expect, it} from 'vitest';
import {createSession, initialWorkbench, parseWorkbench} from './core';
import {durableWorkbench} from './persistence';
import {beginNativeSend, mergeNativeSession, type NativeSession} from './agent-state';

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
  it('keeps unconfirmed text recoverable after reload with the independent composer draft', () => {
    const source: NativeSession = {id:'real',workspaceId:'design',nodeId:null,backend:'pi',title:'Real',cwd:'C:/project',sourceId:null,createdAt:1,revision:1,messages:[],runs:[],requests:[],error:null};
    const state = beginNativeSend(mergeNativeSession(initialWorkbench(),source),'real','pending','Previous unsent text',2);
    state.sessions[0].draft='new draft';
    const restored = parseWorkbench(JSON.parse(JSON.stringify(durableWorkbench(state))));
    expect(restored.sessions[0].draft).toBe('new draft');
    const rehydrated = mergeNativeSession(restored,source);
    expect(rehydrated.runs.at(-1)).toMatchObject({id:'pending',state:'failed',pendingText:'Previous unsent text'});
  });
});
import {snapshotWriter} from './persistence';
it('flushes the latest snapshot even when it matches an earlier write with a different save still queued',async()=>{
  const saved:string[]=[];const writer=snapshotWriter(async value=>{saved.push(value);},()=>{});await writer.write('A');const b=writer.write('B');const a=writer.write('A');await Promise.all([b,a]);expect(saved).toEqual(['A','B','A']);
});
it('allows retrying the same snapshot after a storage failure',async()=>{
  let fail=true;const saved:string[]=[];const errors:unknown[]=[];const writer=snapshotWriter(async value=>{if(fail)throw Error('disk');saved.push(value);},error=>errors.push(error));await expect(writer.write('A')).rejects.toThrow('disk');fail=false;await writer.write('A');expect(saved).toEqual(['A']);expect(errors).toHaveLength(1);
});
