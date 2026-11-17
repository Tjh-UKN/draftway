import {describe,it,expect} from 'vitest';
import {canDockDrop,dockEdge} from './dock-drag';
import {groups,initialDock,moveDockGroup,moveDockTab,openDockTab,splitDockGroup,validateDock} from './docking';
import {createSession,initialWorkbench,parseWorkbench,startDemoRun,updateWorkspace} from './core';

describe('dragged tabs and whole panes',()=>{
  const rect={left:100,top:50,width:1000,height:500};
  const make=()=>moveDockTab(openDockTab(openDockTab(initialDock(),{id:'browser',kind:'browser',title:'Browser',url:'https://example.com/'}),{id:'review',kind:'review',title:'Review',files:[{name:'file.ts',text:'retain this buffer'}]}),'browser','main',undefined,'right','right');
  it('keeps a center merge zone and resolves four pane edges',()=>{
    expect(dockEdge(rect,600,300)).toBeUndefined();expect(dockEdge(rect,110,300)).toBe('left');expect(dockEdge(rect,1090,300)).toBe('right');expect(dockEdge(rect,600,55)).toBe('top');expect(dockEdge(rect,600,545)).toBe('bottom');expect(dockEdge({...rect,width:0},100,100)).toBeUndefined();
  });
  it('moves a complete pane without changing tab IDs, contents or the pane identity',()=>{
    let dock=make();dock=openDockTab(dock,{id:'events',kind:'events',title:'Events'});const before=structuredClone(dock);
    const moved=moveDockGroup(dock,'right','main','bottom','new-position');
    expect(groups(moved.root).map(g=>g.id)).toEqual(['main','right']);expect(groups(moved.root)[1].tabs).toEqual(['browser','events']);expect(moved.activeGroupId).toBe('right');expect(moved.root).toMatchObject({axis:'column'});expect(moved.tabs).toEqual(before.tabs);expect(dock).toEqual(before);expect(()=>validateDock(moved,[])).not.toThrow();
    const left=moveDockGroup(moved,'right','main','left','left-position');expect(groups(left.root).map(g=>g.id)).toEqual(['right','main']);expect(()=>validateDock(left,[])).not.toThrow();
  });
  it('merges panes without duplicate owners and ignores same-pane or stale targets',()=>{
    const dock=make();const merged=moveDockGroup(dock,'right','main');
    expect(groups(merged.root)).toHaveLength(1);expect(groups(merged.root)[0].tabs).toEqual(['workspace','review','browser']);expect(merged.tabs).toEqual(dock.tabs);expect(merged.activeGroupId).toBe('main');expect(()=>validateDock(merged,[])).not.toThrow();
    expect(moveDockGroup(dock,'main','main')).toBe(dock);expect(moveDockGroup(dock,'missing','main')).toBe(dock);expect(canDockDrop(dock,{kind:'group',id:'right',label:'Pane'},{groupId:'main'})).toBe(true);expect(canDockDrop(dock,{kind:'group',id:'right',label:'Pane'},{groupId:'right'})).toBe(false);
  });
  it('allows repositioning the last tab at the pane limit without creating a ninth pane',()=>{
    let dock=initialDock();for(let i=1;i<8;i++){dock=splitDockGroup(dock,groups(dock.root)[0].id,'row','pane-'+i);dock=openDockTab(dock,{id:'b'+i,kind:'browser',title:'Browser '+i,url:''},'pane-'+i);}
    expect(groups(dock.root)).toHaveLength(8);expect(canDockDrop(dock,{kind:'tab',id:'b1',label:'Browser'},{groupId:'main',edge:'bottom'})).toBe(true);
    dock=moveDockTab(dock,'b1','main',undefined,'bottom','new-pane');expect(groups(dock.root)).toHaveLength(8);expect(()=>validateDock(dock,[])).not.toThrow();
    dock=openDockTab(dock,{id:'extra',kind:'browser',title:'Extra',url:''},'new-pane');expect(canDockDrop(dock,{kind:'tab',id:'b1',label:'Browser'},{groupId:'main',edge:'left'})).toBe(false);expect(moveDockTab(dock,'b1','main',undefined,'left')).toBe(dock);
  });
  it('persists rearranged pane layouts while preserving a running conversation and its draft',()=>{
    let state=createSession(initialWorkbench(),'design','think','agent',1);state.sessions[0].draft='keep draft';state=startDemoRun(state,'agent','Keep running','succeeded','run',1);
    state=updateWorkspace(state,'design',w=>({...w,dock:moveDockTab(w.dock,'agent','main',undefined,'right','agent-pane')}));const sessions=structuredClone(state.sessions),runs=structuredClone(state.runs);
    state=updateWorkspace(state,'design',w=>({...w,dock:moveDockGroup(w.dock,'agent-pane','main','left','agent-position')}));
    const restored=parseWorkbench(JSON.parse(JSON.stringify(state)));expect(restored.sessions).toEqual(sessions);expect(restored.runs).toEqual(runs);expect(groups(restored.spaces[0].dock.root).map(g=>g.id)).toEqual(['agent-pane','main']);
  });
});
