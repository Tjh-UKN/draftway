import {describe,expect,it} from 'vitest';
import {createSession,editNodeBody,initialWorkbench,mapGraph,openMapTab,parseWorkbench,renameMapNode,startDemoRun,type WorkbenchState} from './core';
import {openDockTab} from './docking';
import {clipboardNodes,copyMapBranch,createMapSibling,deleteMapBranch,moveMapBranch,pasteMapBranch} from './node-operations';
import {initialMapEditor,mapEditorReducer,type MapEditor} from './map-editor';

function edit(editor:MapEditor,update:(s:WorkbenchState)=>WorkbenchState,key?:string,at=1){return mapEditorReducer(editor,{type:'edit',workspaceId:'design',update,key,at});}
const undo=(editor:MapEditor)=>mapEditorReducer(editor,{type:'undo',workspaceId:'design'});
const redo=(editor:MapEditor)=>mapEditorReducer(editor,{type:'redo',workspaceId:'design'});

describe('mind map editing',()=>{
  it('deletes a branch and repairs all map/material/session references while retaining conversations',()=>{
    let state=createSession(initialWorkbench(),'design','simplicity','s',1);state.sessions[0].linkedNodeIds=['simplicity','composition'];
    state=startDemoRun(state,'s','Keep the conversation','succeeded','run',2,'artifact','simplicity');
    state.spaces[0]=openMapTab(state.spaces[0],state.spaces[0].dock.activeGroupId,'other');
    state.spaces[0].graph={selectedId:'think',focusId:'think',collapsed:['think','simplicity'],camera:{x:1,y:2,zoom:1}};
    state.spaces[0].dock.tabs=state.spaces[0].dock.tabs.map(t=>t.id==='other'?{...t,graph:{...state.spaces[0].graph}}:t);
    state.spaces[0].nodes.find(n=>n.id==='simplicity')!.materials=[{id:'m',title:'Material',target:'https://example.com/'}];
    state.spaces[0].dock=openDockTab(state.spaces[0].dock,{id:'material',kind:'material',title:'Material',nodeId:'simplicity',materialId:'m'});
    const next=deleteMapBranch(state,'design','think');
    expect(next.spaces[0].nodes.some(n=>['think','simplicity','composition'].includes(n.id))).toBe(false);
    expect(next.spaces[0].graph).toMatchObject({selectedId:null,focusId:null,collapsed:[],camera:null});
    expect(mapGraph(next.spaces[0],'other')).toMatchObject({selectedId:null,focusId:null,collapsed:[]});
    expect(next.spaces[0].dock.tabs.some(t=>t.id==='material')).toBe(false);
    expect(next.sessions[0]).toMatchObject({nodeId:null,linkedNodeIds:[],messages:state.sessions[0].messages});
    expect(next.runs[0]).toMatchObject({state:'running',mapAction:'reply'});expect(next.runs[0].targetNodeId).toBeUndefined();
    expect(()=>parseWorkbench(next)).not.toThrow();expect(deleteMapBranch(state,'design','northstar')).toBe(state);
  });
  it('undoes and redoes deletion without discarding later AI messages or unrelated node updates',()=>{
    const state=createSession(initialWorkbench(),'design','simplicity','s',1);state.sessions[0].draft='Keep draft';
    let editor=edit(initialMapEditor(state),s=>deleteMapBranch(s,'design','think'));
    editor=mapEditorReducer(editor,{type:'change',update:s=>({...editNodeBody(s,'design','experience','New AI content'),sessions:s.sessions.map(session=>({...session,messages:[...session.messages,{id:'later',role:'assistant',text:'Later reply',at:2}]}))})});
    editor=undo(editor);expect(editor.error).toBe('');expect(editor.state.spaces[0].nodes.find(n=>n.id==='think')).toBeDefined();
    expect(editor.state.spaces[0].nodes.find(n=>n.id==='experience')!.body).toBe('New AI content');expect(editor.state.sessions[0]).toMatchObject({nodeId:'simplicity',draft:'Keep draft'});expect(editor.state.sessions[0].messages.at(-1)?.text).toBe('Later reply');
    editor=redo(editor);expect(editor.state.spaces[0].nodes.some(n=>n.id==='think')).toBe(false);expect(editor.state.sessions[0].nodeId).toBeNull();expect(()=>parseWorkbench(editor.state)).not.toThrow();
  });
  it('creates siblings, moves branches and rejects roots and parent cycles',()=>{
    const initial=initialWorkbench();const sibling=createMapSibling(initial,'design','simplicity','sibling','workspace');
    expect(sibling.spaces[0].nodes.filter(n=>n.parentId==='think').map(n=>n.id)).toEqual(['simplicity','sibling','composition']);
    const moved=moveMapBranch(sibling,'design','think','act','inside');expect(moved.spaces[0].nodes.find(n=>n.id==='think')!.parentId).toBe('act');
    expect(moveMapBranch(moved,'design','act','simplicity','inside')).toBe(moved);expect(moveMapBranch(moved,'design','northstar','act','inside')).toBe(moved);expect(()=>parseWorkbench(moved)).not.toThrow();
    const editor=edit(initialMapEditor(initial),s=>moveMapBranch(s,'design','spaces','link','before'));
    expect(editor.past.design).toHaveLength(1);expect(undo(editor).state.spaces[0].nodes.map(n=>n.id)).toEqual(initial.spaces[0].nodes.map(n=>n.id));
  });
  it('copies full branches with fresh IDs and material references without cloning agent identities',()=>{
    const state=initialWorkbench();const original=state.spaces[0].nodes.find(n=>n.id==='simplicity')!;
    Object.assign(original,{body:'Keep full body',materials:[{id:'m',title:'Note',target:'https://example.com/'}],updates:[{id:'u',text:'History',sessionId:'foreign-session',at:1}],sourceArtifactId:'source'});
    const clip=copyMapBranch(state.spaces[0],'think')!;expect(clip.text).toBe('想清楚\n\t一个中心，逐层展开\n\t工具围绕事情组织');
    const next=pasteMapBranch(state,'design','act',clipboardNodes(clip.text,clip),['a','b','c'],'workspace');
    expect(next.spaces[0].nodes.find(n=>n.id==='b')).toMatchObject({parentId:'a',body:'Keep full body',materials:original.materials});
    expect(next.spaces[0].nodes.find(n=>n.id==='b')?.updates).toBeUndefined();expect(next.spaces[0].nodes.find(n=>n.id==='b')?.sourceArtifactId).toBeUndefined();expect(next.sessions).toEqual(state.sessions);expect(()=>parseWorkbench(next)).not.toThrow();
    expect(clipboardNodes('Plain text\n\tChild\nSibling',null).map(n=>n.parentId)).toEqual([null,'paste-0',null]);
    expect(()=>clipboardNodes('x\n'.repeat(251),null)).toThrow('250');
    expect(()=>pasteMapBranch(state,'design','act',clip.nodes,new Array(clip.nodes.length).fill('duplicate'),'workspace')).toThrow();
  });
  it('deletes selected forests once, protects the center and restores the whole batch in one undo',()=>{
    const state=initialWorkbench(),ids=state.spaces[0].nodes.map(n=>n.id);
    const editor=edit(initialMapEditor(state),s=>deleteMapBranch(s,'design',ids));
    expect(editor.state.spaces[0].nodes.map(n=>n.id)).toEqual(['northstar']);expect(editor.past.design).toHaveLength(1);
    const restored=undo(editor);expect(restored.state.spaces[0].nodes).toEqual(state.spaces[0].nodes);expect(()=>parseWorkbench(restored.state)).not.toThrow();
    expect(redo(restored).state.spaces[0].nodes).toHaveLength(1);
  });
  it('copies and moves multiple branches without duplicating selected descendants or creating cycles',()=>{
    const state=initialWorkbench(),space=state.spaces[0];
    const clip=copyMapBranch(space,['simplicity','composition','think','spaces'])!;
    expect(clip.nodes.filter(n=>n.id==='simplicity')).toHaveLength(1);expect(clip.nodes.map(n=>n.id)).toContain('spaces');
    const moved=moveMapBranch(state,'design',['simplicity','composition'],'act','inside');
    expect(moved.spaces[0].nodes.filter(n=>['simplicity','composition'].includes(n.id)).map(n=>n.parentId)).toEqual(['act','act']);
    expect(moveMapBranch(state,'design',['think','simplicity','spaces'],'simplicity','inside')).toBe(state);
    const editor=edit(initialMapEditor(state),s=>moveMapBranch(s,'design',['simplicity','composition'],'act','inside'));
    expect(undo(editor).state.spaces[0].nodes).toEqual(space.nodes);expect(()=>parseWorkbench(moved)).not.toThrow();
    const pasted=pasteMapBranch(state,'design','act',clip.nodes,clip.nodes.map((_,i)=>'forest-'+i),'workspace');
    expect(pasted.spaces[0].nodes.filter(n=>n.id.startsWith('forest-')&&n.parentId==='act')).toHaveLength(2);expect(()=>parseWorkbench(pasted)).not.toThrow();
  });
  it('protects external AI changes from undo and keeps history isolated per workspace',()=>{
    let editor=edit(initialMapEditor(initialWorkbench()),s=>renameMapNode(s,'design','simplicity','My edit'));
    editor=mapEditorReducer(editor,{type:'change',update:s=>renameMapNode(s,'design','simplicity','Later external title')});
    expect(undo(editor).error).toContain('未覆盖');expect(undo(editor).state.spaces[0].nodes.find(n=>n.id==='simplicity')?.title).toBe('Later external title');
    expect(mapEditorReducer(editor,{type:'undo',workspaceId:'review'}).state).toBe(editor.state);
  });
  it('groups body typing without putting concurrent AI update history into the undo frame',()=>{
    let editor=edit(initialMapEditor(initialWorkbench()),s=>editNodeBody(s,'design','simplicity','A'),'body:simplicity',1);
    editor=mapEditorReducer(editor,{type:'change',update:s=>({...s,spaces:s.spaces.map(w=>w.id==='design'?{...w,nodes:w.nodes.map(n=>n.id==='simplicity'?{...n,updates:[{id:'ai',text:'Keep history',at:2}]}:n)}:w)})});
    editor=edit(editor,s=>editNodeBody(s,'design','simplicity','AB'),'body:simplicity',2);expect(editor.past.design).toHaveLength(1);
    const reverted=undo(editor);expect(reverted.state.spaces[0].nodes.find(n=>n.id==='simplicity')?.body).toBe(initialWorkbench().spaces[0].nodes.find(n=>n.id==='simplicity')!.body);expect(reverted.state.spaces[0].nodes.find(n=>n.id==='simplicity')?.updates?.[0].id).toBe('ai');
  });
});
