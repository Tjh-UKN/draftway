import {describe,it,expect} from 'vitest';
import {importKnowledge,knowledgeHierarchy,knowledgeRoot,newKnowledge,parseKnowledgeMap,validateKnowledge,isolatedHtml,knowledgeFormat} from './knowledge-graph';
import type {Note} from './domain';
describe('hierarchical knowledge',()=>{
  it('keeps original records and groups collected material under its source workspace',()=>{
    const note=newKnowledge('markdown') as Note;note.title='资料';note.knowledgeSource={kind:'node',workspaceId:'w',workspaceName:'工作区',id:'n',category:'document'};delete note.knowledgeParentId;
    const folder=newKnowledge('folder'),drawing=newKnowledge('excalidraw',folder.id);
    const nodes=knowledgeHierarchy([note,folder,drawing]);expect(nodes.find(n=>n.id===note.id)?.parentId).toBe('source:w');expect(nodes.find(n=>n.id===drawing.id)?.parentId).toBe(folder.id);expect(nodes.find(n=>n.id==='source:w')?.title).toBe('工作区');expect(drawing.knowledgeParentId).toBe(folder.id);expect(knowledgeHierarchy([note,folder,drawing],'工作区').some(n=>n.id===note.id)).toBe(true);
    note.knowledgeParentId=null;expect(knowledgeHierarchy([note]).find(n=>n.id===note.id)?.parentId).toBe(knowledgeRoot);
  });
  it('search retains ancestors and invalid restored links remain reachable',()=>{
    const parent=newKnowledge('folder'),child=newKnowledge('markdown',parent.id) as Note;child.body='needle';const nodes=knowledgeHierarchy([parent,child],'  NEEDLE  ');expect(nodes.map(n=>n.id)).toEqual([knowledgeRoot,parent.id,child.id]);parent.knowledgeParentId=child.id;expect(()=>knowledgeHierarchy([parent,child])).not.toThrow();expect(()=>validateKnowledge(parent,[parent,child])).toThrow('下级');
    parent.archived=true;expect(knowledgeHierarchy([parent,child]).find(n=>n.id===child.id)?.parentId).toBe(knowledgeRoot);
  });
  it('imports HTML, Markdown, Excalidraw and mind maps without converting their payload',async()=>{
    const html='<!doctype html><title>交互</title><button onclick="this.textContent=2">1</button>';
    const imported=await importKnowledge(new File([html],'演示.html'),null) as Note;expect(imported.body).toBe(html);expect(imported.format).toBe('html');expect(knowledgeFormat({...imported,format:undefined})).toBe('html');
    const map=newKnowledge('mindmap') as Note;const parsed=await importKnowledge(new File([map.body],'导图.json'),null) as Note;expect(parsed.format).toBe('mindmap');expect(parseKnowledgeMap(parsed.body)).toEqual(JSON.parse(map.body));
    const scene='{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}';const drawing=await importKnowledge(new File([scene],'图.excalidraw'),null);expect(drawing.kind).toBe('drawing');if(drawing.kind==='drawing')expect(drawing.scene).toBe(scene);
    expect((await importKnowledge(new File(['# markdown'],'文档.md'),null) as Note).body).toBe('# markdown');
  });
  it('rejects malformed maps, unsupported files and parent cycles',async()=>{
    await expect(importKnowledge(new File(['bad'],'文档.pdf'),null)).rejects.toThrow('支持');expect(()=>parseKnowledgeMap('[]')).toThrow();const map=newKnowledge('mindmap') as Note;const nodes=JSON.parse(map.body);nodes.push({...nodes[0],id:'cycle',parentId:'cycle',kind:'idea'});expect(()=>parseKnowledgeMap(JSON.stringify(nodes))).toThrow('关系');
    const folder=newKnowledge('folder');folder.knowledgeParentId=folder.id;expect(()=>validateKnowledge(folder,[folder])).toThrow('下级');
  });
  it('puts HTML isolation policy before the user document',()=>{const html=isolatedHtml('<script>document.title="example"</script>');expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));expect(html).toContain("connect-src 'none'");expect(html).toContain("script-src 'unsafe-inline'");});
});
