import {describe, expect, it} from 'vitest';
import {createSession, initialWorkbench, parseWorkbench, selectWorkspaceTab} from './core';
import {beginNativeSend,mergeNativeSession,rejectNativeSend, type NativeSession} from './agent-state';

const native = (revision = 1): NativeSession => ({id: 'real', workspaceId: 'design', nodeId: null, backend: 'codex', title: '实际会话', cwd: 'C:\\project', sourceId: 'thread', createdAt: 1, revision, messages: [{id: 'r-item', role: 'assistant', text: '真实结果', at: 2}], runs: [{id: 'r', state: 'succeeded', startedAt: 1, finishedAt: 3, error: null}], requests: [], error: null});
describe('native session projection', () => {
  it('shows a send immediately and keeps failed delivery separate from a newer draft across retry',()=>{
    const initial=mergeNativeSession(createSession(initialWorkbench(),'design',null,'real',1),native());
    const text=' \t\n原样传递\n ';
    const sent=beginNativeSend(initial,'real','next',text,4);
    expect(sent.sessions[0].messages.at(-1)?.text).toBe(text);expect(sent.runs.at(-1)).toMatchObject({state:'running',phase:'sending'});
    const writing = {...sent,sessions:sent.sessions.map(s=>({...s,draft:'new draft'}))};
    const renamed = mergeNativeSession(writing, {...native(2),title:'renamed while sending'});
    expect(renamed.runs.at(-1)).toMatchObject({id:'next',state:'running'});
    expect(renamed.sessions[0].messages.at(-1)?.text).toBe(text);
    const rejected=rejectNativeSend(renamed,'real','next','not accepted');
    expect(rejected.sessions[0].draft).toBe('new draft');expect(rejected.sessions[0].messages).toEqual(initial.sessions[0].messages);
    expect(rejected.runs.at(-1)).toMatchObject({id:'next',state:'failed',pendingText:text,error:'not accepted'});
    const retried=beginNativeSend(rejected,'real','next',text,5,true);
    expect(retried.sessions[0].draft).toBe('new draft');
    expect(retried.sessions[0].messages.at(-1)?.text).toBe(text);
    const update=native(3);
    update.messages.push({id:'next-user',role:'user',text,at:5});
    update.runs.push({id:'next',state:'running',startedAt:5,finishedAt:null,error:null});
    const accepted=mergeNativeSession(retried,update);
    expect(accepted.runs.at(-1)?.pendingText).toBeUndefined();
    expect(accepted.sessions[0].draft).toBe('new draft');
    expect(rejectNativeSend(accepted,'real','next','late transport error')).toBe(accepted);
  });
  it('replaces optimistic delivery with observed Codex phases and activity without changing the transcript', () => {
    const initial = mergeNativeSession(initialWorkbench(), native());
    const sent = beginNativeSend(initial, 'real', 'next', 'Inspect README', 4);
    const update = native(2);
    update.messages.push({id:'next-user', role:'user', text:'Inspect README', at:4});
    update.runs.push({id:'next', state:'running', startedAt:4, finishedAt:null, error:null, phase:'executing',
      activity:[{id:'read',kind:'command',title:'Get-Content README.md',status:'running'}]});
    const running = mergeNativeSession(sent, update);
    expect(running.runs.filter(run=>run.id==='next')).toEqual([expect.objectContaining({
      phase:'executing',activity:update.runs[1].activity,
    })]);
    expect(running.sessions[0].messages).toEqual(sent.sessions[0].messages);
    expect(mergeNativeSession(running, native())).toBe(running);
  });
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
  it('migrates RC8 model choices and preserves them when native snapshots report thread settings', () => {
    const initial = createSession(initialWorkbench(), 'design', null, 'real', 1);
    Object.assign(initial.sessions[0], {codexModel:'selected-model', codexEffort:'high'});
    const upgraded = parseWorkbench(initial);
    expect(upgraded.sessions[0]).not.toHaveProperty('codexModel');
    const next = mergeNativeSession(upgraded, {...native(), effectiveModel:'current-model', effectiveEffort:'medium'});
    expect(parseWorkbench(JSON.parse(JSON.stringify(next))).sessions[0]).toMatchObject({
      selectedModel:'selected-model', selectedEffort:'high', effectiveModel:'current-model', effectiveEffort:'medium',
    });
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
  it('restores an interrupted send in the same session without creating an artifact or replacing the draft', () => {
    const initial = createSession(initialWorkbench(), 'design', null, 'real', 1);
    initial.sessions[0].draft = 'next step';
    const value = native();
    value.runs[0].state = 'interrupted';
    value.messages = [{id: 'r-user', role: 'user', text: 'previous prompt', at: 2}];
    const state = mergeNativeSession(initial, value, false, false);
    expect(state.sessions[0]).toMatchObject({id: 'real', sourceId: 'thread', draft: 'next step', messages: value.messages});
    expect(state.runs[0].state).toBe('interrupted');
    expect(state.artifacts).toEqual([]);
    expect(state.notices).toEqual([]);
    expect(parseWorkbench(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});
