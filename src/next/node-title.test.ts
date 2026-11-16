import {describe, expect, it} from 'vitest';
import {editNodeBody, initialWorkbench, parseWorkbench, renameMapNode} from './core';

describe('independent node title and information', () => {
  it('renames only the title while retaining the latest body, resources, progress and source', () => {
    const state=initialWorkbench();const node=state.spaces[0].nodes.find(n=>n.id==='simplicity')!;
    Object.assign(node,{body:'AI 更新后的正文\n保留完整段落',task:true,progress:45,due:'2026-12-01',materials:[{id:'note',title:'Note',target:'https://example.com/'}],sourceArtifactId:'source',updates:[{id:'update',text:'Keep this history',at:1}]});
    state.spaces[0].graph.selectedId=node.id;
    const before=structuredClone(node);const graph=structuredClone(state.spaces[0].graph);
    const next=renameMapNode(state,'design',node.id,'新的标题');
    expect(next.spaces[0].nodes.find(n=>n.id===node.id)).toEqual({...before,title:'新的标题'});
    expect(next.spaces[0].graph).toEqual(graph);
    expect(node).toEqual(before);
    expect(renameMapNode(next,'design',node.id,'   ')).toBe(next);
  });
  it('edits and clears the body without renaming or reclassifying the node', () => {
    let state=initialWorkbench();const id='simplicity';
    state=renameMapNode(state,'design',id,'独立标题');
    const node=structuredClone(state.spaces[0].nodes.find(n=>n.id===id)!);
    const next=editNodeBody(state,'design',id,'只修改正文\n  保留缩进');
    expect(next.spaces[0].nodes.find(n=>n.id===id)).toEqual({...node,body:'只修改正文\n  保留缩进'});
    expect(editNodeBody(next,'design',id,'').spaces[0].nodes.find(n=>n.id===id)).toMatchObject({title:'独立标题',body:''});
    expect(editNodeBody(next,'review',id,'Foreign workspace')).toBe(next);
  });
  it('keeps pasted names on one line and validates Unicode without touching the body', () => {
    const state=initialWorkbench();const before=state.spaces[0].nodes[0];
    const next=renameMapNode(state,'design',before.id,' 新标题\r\n第二行 ');
    expect(next.spaces[0].nodes[0]).toMatchObject({title:'新标题 第二行',body:before.body});
    const unicode=renameMapNode(next,'design',before.id,'a'+'🚀'.repeat(100));
    expect(unicode.spaces[0].nodes[0].body).toBe(before.body);
    expect(()=>parseWorkbench(unicode)).not.toThrow();
  });
});
