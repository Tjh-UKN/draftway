import {describe, expect, it} from 'vitest';
import {initialWorkbench, parseWorkbench, type Notice} from './core';
import {mergeBackground} from './background-state';
import {openDockTab} from './docking';
describe('background notifications', () => {
  it('restores report targets without fabricated sessions and retains local read state', () => {
    let state=initialWorkbench();const workspace=state.spaces[0];
    const notice: Notice={id:'report-1',workspaceId:workspace.id,title:'检视完成',target:{kind:'report',url:'http://127.0.0.1:8765/',file:'round-test.json'},read:false,at:10};
    const snapshot={revision:1,error:null,notices:[notice],reviews:{}};
    state=mergeBackground(state,snapshot);state.notices[0].read=true;state=mergeBackground(state,snapshot);expect(state.notices).toHaveLength(1);expect(state.notices[0].read).toBe(true);expect(state.sessions).toHaveLength(0);
    workspace.dock=openDockTab(workspace.dock,{id:'report',kind:'report',title:'Report',url:'http://127.0.0.1:8765/',file:'round-test.json'});
    expect(parseWorkbench(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
  it('ignores notices for absent workspaces and rejects traversal targets on restore', () => {
    const state=initialWorkbench();const notice: Notice={id:'x',workspaceId:'absent',title:'x',read:false,at:1,target:{kind:'workspace'}};
    expect(mergeBackground(state,{revision:1,error:null,notices:[notice],reviews:{}}).notices).toHaveLength(0);
    state.notices=[{...notice,workspaceId:state.activeId,target:{kind:'report',url:'http://localhost:8765/',file:'round-../../secret.json'}}];expect(()=>parseWorkbench(state)).toThrow();
  });
});
