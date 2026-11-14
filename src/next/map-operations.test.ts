import {describe,expect,it} from 'vitest';
import {initialWorkbench,parseWorkbench} from './core';
import {applyMapOperations,type MapOperation} from './map-operations';
describe('AI map changes',()=>{
  it('preserves concurrent content edits and keeps progress independent',()=>{
    let state=initialWorkbench();const node=state.spaces[0].nodes[0];node.body='User edit';node.progress=20;
    const op:MapOperation={seq:1,id:'edit',workspaceId:state.activeId,nodeId:node.id,sessionId:'s',runId:'r',kind:'update',payload:{expectedBody:'old',body:'AI proposal',text:'Update'},at:1};
    state=applyMapOperations(state,[op]);expect(state.spaces[0].nodes[0].body).toBe('User edit');expect(state.spaces[0].nodes[0].updates?.[0].text).toContain('AI proposal');expect(state.spaces[0].nodes[0].progress).toBe(20);expect(applyMapOperations(state,[op])).toBe(state);expect(parseWorkbench(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
  it('retains artifacts only for explicit operations, with source and no layout changes',()=>{
    const state=initialWorkbench();const node=state.spaces[0].nodes[0];const op:MapOperation={seq:2,id:'keep',workspaceId:state.activeId,nodeId:node.id,sessionId:'s',runId:'r',kind:'artifact',payload:{title:'Design',body:'Result'},at:1};
    const next=applyMapOperations(state,[op]);expect(next.spaces[0].nodes).toHaveLength(state.spaces[0].nodes.length+1);expect(next.spaces[0].nodes.at(-1)?.updates?.[0].sessionId).toBe('s');expect(next.spaces[0].dock).toBe(state.spaces[0].dock);expect(next.sessions).toBe(state.sessions);
  });
});
