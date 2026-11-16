import {describe, expect, it} from 'vitest';
import {addSubtask, editNodeContent, initialWorkbench, parseWorkbench, setNodeTask, setTaskProgress} from './core';
import {contentFields, hasLegacyNodePrimitives, isTask, nodeContent, nodeProgress, parseState, seedState} from './model';
import {openDockTab} from './docking';

describe('canonical node primitives', () => {
  it('migrates steps to real task nodes without changing the original snapshot', () => {
    const old=seedState();const parent=old.spaces[0].nodes.find(n=>n.id==='link')!;
    Object.assign(parent,{steps:[{id:'a',title:'已完成',done:true},{id:'b',title:'待完成',done:false}]});
    const source=JSON.stringify(old);const next=parseState(old);const nodes=next.spaces[0].nodes;
    expect(hasLegacyNodePrimitives(old)).toBe(true);expect(hasLegacyNodePrimitives(next)).toBe(false);
    const children=nodes.filter(n=>n.parentId==='link');
    expect(children.map(n=>({title:n.title,progress:n.progress,task:n.task}))).toEqual([{title:'已完成',progress:100,task:true},{title:'待完成',progress:0,task:true}]);
    expect(nodes.find(n=>n.id==='link')).toMatchObject({progress:50});
    expect(nodes.find(n=>n.id==='link')).not.toHaveProperty('steps');
    expect(nodes.find(n=>n.id==='link')?.updates?.some(u=>u.text.includes('75%'))).toBe(true);
    expect(nodeProgress(nodes,'northstar')).toBe(37);
    expect(parseState(next)).toEqual(next);
    expect(parseState(JSON.parse(source))).toEqual(next);
    expect(JSON.stringify(old)).toBe(source);
  });
  it('keeps completion as one task progress value while retaining artifact identity', () => {
    const old=seedState();const node=old.spaces[0].nodes[1];
    Object.assign(node,{kind:'artifact',completed:true,sourceArtifactId:'retained-result'});
    const migrated=parseState(old).spaces[0].nodes[1];
    expect(migrated).toMatchObject({kind:'artifact',task:true,progress:100,sourceArtifactId:'retained-result'});
    expect(migrated).not.toHaveProperty('completed');
  });
  it('keeps the former manual progress in history when nested tasks begin rolling up', () => {
    const old=seedState();const parent=old.spaces[0].nodes.find(n=>n.id==='link')!;
    old.spaces[0].nodes.push({...parent,id:'existing-child',parentId:parent.id,progress:100,title:'Existing nested task'});
    const next=parseState(old);const migrated=next.spaces[0].nodes.find(n=>n.id===parent.id)!;
    expect(migrated.progress).toBe(100);expect(migrated.updates?.some(u=>u.text.includes('75%'))).toBe(true);
    expect(parseState(next)).toEqual(next);
  });
  it('migrates and deduplicates references, preserving already-open material tabs', () => {
    const old=initialWorkbench();const node=old.spaces[0].nodes[0];
    node.materials=[{id:'first',title:'Docs',target:'https://example.com/'},{id:'duplicate',title:'Same docs',target:'https://example.com'}];
    Object.assign(node,{reference:'https://example.com'});
    old.spaces[0].dock=openDockTab(old.spaces[0].dock,{id:'reference-tab',kind:'material',title:'Docs',nodeId:node.id,materialId:'legacy-reference'});
    old.spaces[0].dock=openDockTab(old.spaces[0].dock,{id:'duplicate-tab',kind:'material',title:'Docs',nodeId:node.id,materialId:'duplicate'});
    const next=parseWorkbench(old);
    expect(next.spaces[0].nodes[0].materials).toHaveLength(1);
    expect(next.spaces[0].dock.tabs.filter(t=>t.kind==='material').map(t=>t.materialId)).toEqual(['first','first']);
    expect(next.spaces[0].nodes[0]).not.toHaveProperty('reference');
    expect(next.spaces[0].nodes[0].updates?.some(u=>u.text.includes('Same docs'))).toBe(true);
    expect(parseWorkbench(next)).toEqual(next);
  });
  it('preserves unopenable legacy references as content and opens their tab at the node', () => {
    const old=initialWorkbench();const node=old.spaces[0].nodes[0];Object.assign(node,{reference:'old relative note.md'});
    old.spaces[0].dock=openDockTab(old.spaces[0].dock,{id:'old-ref',kind:'material',title:'Old note',nodeId:node.id,materialId:'legacy-reference'});
    const next=parseWorkbench(old);
    expect(next.spaces[0].nodes[0].body).toContain('引用：old relative note.md');
    expect(next.spaces[0].dock.tabs.find(t=>t.id==='old-ref')).toMatchObject({kind:'map',graph:{selectedId:node.id}});
  });
  it('uses a single content editor without truncating long first lines or changing stored body text', () => {
    const node=seedState().spaces[0].nodes[0];
    expect(contentFields(nodeContent(node))).toEqual({title:node.title,body:node.body});
    const heading='🚀'.repeat(100);const fields=contentFields(heading+'\n  indented body\n')!;
    expect(fields.title.length).toBeLessThanOrEqual(120);
    expect(fields.title+fields.body.split('\n')[0]).toBe(heading);
    expect(fields.body).toContain('\n  indented body\n');
    const state=initialWorkbench();const next=editNodeContent(state,'design','northstar','一个节点\n完整内容');
    expect(next.spaces[0].nodes[0]).toMatchObject({title:'一个节点',body:'完整内容'});
    expect(editNodeContent(next,'design','northstar','   ')).toBe(next);
  });
  it('adds progress to any node and rolls real child task progress up through its ancestors', () => {
    let state=initialWorkbench();state=setNodeTask(state,'design','think',true);
    state=addSubtask(state,'design','think','child-one');state=addSubtask(state,'design','think','child-two');
    state=setTaskProgress(state,'design','child-one',100);
    expect(state.spaces[0].nodes.find(n=>n.id==='think')).toMatchObject({task:true,progress:50});
    expect(setTaskProgress(state,'design','think',80)).toBe(state);
    state=setTaskProgress(state,'design','child-two',100);
    expect(nodeProgress(state.spaces[0].nodes,'think')).toBe(100);
    expect(isTask(state.spaces[0].nodes.find(n=>n.id==='child-one')!)).toBe(true);
    state.spaces[0].nodes.find(n=>n.id==='child-one')!.due='2026-12-01';
    state=setNodeTask(state,'design','child-one',false);state=setNodeTask(state,'design','child-one',true);
    expect(state.spaces[0].nodes.find(n=>n.id==='child-one')).toMatchObject({progress:100,due:'2026-12-01'});
    expect(()=>parseWorkbench(state)).not.toThrow();
  });
  it('fails atomically instead of silently discarding old steps at the node limit', () => {
    const old=seedState();const space=old.spaces[0];const root=space.nodes[0];
    while(space.nodes.length<250)space.nodes.push({...root,id:'extra-'+space.nodes.length,parentId:root.id,kind:'idea'});
    Object.assign(root,{steps:[{id:'overflow',title:'Keep this step',done:true}]});const original=JSON.stringify(old);
    expect(()=>parseState(old)).toThrow('250');expect(JSON.stringify(old)).toBe(original);
  });
});
