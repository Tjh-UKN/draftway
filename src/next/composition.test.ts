import {describe,it,expect} from 'vitest';
import {initialWorkbench,createSession,parseWorkbench,mapGraph,openMapTab,updateMapGraph} from './core';
import {openDockTab} from './docking';
import {layoutTemplate,fromTemplate,parseIntegration} from './composition';
describe('workspace composition',()=>{
  it('reuses layout with fresh browser identities and no conversation or file snapshots',()=>{
    const state=createSession(initialWorkbench(),'design',null,'session',0);const space=state.spaces[0];space.dock=openDockTab(space.dock,{id:'web',kind:'browser',url:'http://localhost:8765/',title:'Review'});space.dock=openDockTab(space.dock,{id:'code',kind:'review',title:'Code',files:[{name:'private',text:'Private file'}]});
    const template=layoutTemplate(space,'template','Layout');const next=fromTemplate('Next',template,(()=>{let i=0;return()=>`new-${++i}`;})());expect(next.dock.tabs.some(t=>t.kind==='session')).toBe(false);expect(next.dock.tabs.find(t=>t.kind==='browser')?.id).not.toBe('web');expect(next.dock.tabs.find(t=>t.kind==='review')).toMatchObject({files:[]});expect(next.nodes).toHaveLength(1);expect(next.cwd).toBeUndefined();expect(parseWorkbench({...state,templates:[template],spaces:[...state.spaces,next]}).templates).toHaveLength(1);
  });
  it('registers declarative web tools without executing commands or claiming optional capabilities',()=>{
    const value={protocol:'northstar.integration/1',id:'local.review',version:'1',name:'Review',surfaces:[{id:'dashboard',kind:'webview',entry:'http://127.0.0.1:8765/'}],capabilities:['surface.open','runs.observe'],command:'untrusted'};
    const parsed=parseIntegration(value);expect(parsed.capabilities).toContain('runs.observe');expect(parsed).not.toHaveProperty('command');expect(()=>parseIntegration({...value,id:'codex'})).toThrow();expect(()=>parseIntegration({...value,surfaces:[{id:'x',kind:'webview',entry:'javascript:alert(1)'}]})).toThrow();
  });
  it('copies multiple map views as fresh tabs without foreign node selections',()=>{
    const state=initialWorkbench();let space=openMapTab(state.spaces[0],'main','extra-map');
    space=updateMapGraph(space,{selectedId:'act',focusId:'act',collapsed:['think'],camera:{x:20,y:10,zoom:.5}},'extra-map');
    const template=layoutTemplate(space,'maps','Maps');
    const next=fromTemplate('Next',template,()=> 'new-map');
    expect(next.dock.tabs.filter(t=>t.kind==='map').map(t=>t.id)).toEqual(['workspace','new-map']);
    expect(mapGraph(next,'new-map')).toEqual({selectedId:null,focusId:null,collapsed:[],camera:null});
    expect(next.nodes).toHaveLength(1);
    expect(()=>parseWorkbench({...state,templates:[template],spaces:[...state.spaces,next]})).not.toThrow();
  });
});
