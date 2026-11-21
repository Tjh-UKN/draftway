import {makeRecord,recordText,type Drawing,type KnowledgeFormat,type Note,type RecordItem} from './domain';
import {createWorkspace,type WorkbenchState} from './next/core';
import {parseState,type MindNode} from './next/model';
import {parseDrawingScene,MAX_SCENE_BYTES} from './drawings';

export type KnowledgeRecord=Note|Drawing;
export const knowledgeRoot='knowledge-root';
export const sourceFolder=(id:string)=>'source:'+id;
export const knowledgeFormat=(record:KnowledgeRecord)=>record.kind==='drawing'?'excalidraw':record.format||(/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(record.body)?'html':'markdown');
export const knowledgeLabels={markdown:'Markdown',html:'HTML',mindmap:'思维导图',folder:'分支',excalidraw:'Excalidraw'};
export const knowledgeRecords=(records:RecordItem[])=>records.filter((r):r is KnowledgeRecord=>!r.archived&&(r.kind==='note'||r.kind==='drawing'));
export function newKnowledge(format:KnowledgeFormat|'excalidraw',parentId:string|null=null):KnowledgeRecord {
  const record=makeRecord(format==='excalidraw'?'drawing':'note') as KnowledgeRecord;
  record.title={markdown:'未命名笔记',html:'未命名网页',mindmap:'未命名思维导图',folder:'新分支',excalidraw:'未命名画板'}[format];
  record.knowledgeParentId=parentId===knowledgeRoot?null:parentId;
  if(record.kind==='note'){record.format=format as KnowledgeFormat;if(format==='html')record.body='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>新网页</title><body><h1>新网页</h1></body></html>';if(format==='mindmap')record.body=JSON.stringify([{id:crypto.randomUUID(),parentId:null,title:'中心主题',body:'',side:1,kind:'root',progress:0,due:''}]);}
  return record;
}
export function parseKnowledgeMap(body:string):MindNode[] {
  const value:unknown=JSON.parse(body);const nodes=Array.isArray(value)?value:(value as {nodes?:unknown})?.nodes;
  const space=createWorkspace('思维导图','blank');space.nodes=nodes as MindNode[];
  return parseState({version:2,activeId:space.id,spaces:[space]}).spaces[0].nodes;
}
export function knowledgeMapState(note:Note):WorkbenchState {
  const space=createWorkspace(note.title,'blank');space.id=note.id;space.nodes=parseKnowledgeMap(note.body);
  return {version:2,activeId:space.id,spaces:[space],sessions:[],runs:[],artifacts:[],notices:[]};
}
export function validateKnowledge(record:RecordItem,records:RecordItem[]) {
  if(record.kind!=='note'&&record.kind!=='drawing')return;
  if(record.kind==='note'){
    if(record.format&&!['markdown','html','mindmap','folder'].includes(record.format))throw Error('知识内容类型无效');
    if(new TextEncoder().encode(record.body).length>1_000_000)throw Error('内容超过 1 MB');
    if(record.format==='mindmap')parseKnowledgeMap(record.body);
  }
  if(record.knowledgeParentId!==undefined&&record.knowledgeParentId!==null&&(typeof record.knowledgeParentId!=='string'||record.knowledgeParentId.length>240))throw Error('知识分支无效');
  const seen=new Set([record.id]);let parent=record.knowledgeParentId;
  while(parent&&!parent.startsWith('source:')){
    if(seen.has(parent))throw Error('不能把知识移到自己的下级');seen.add(parent);
    const item=records.find(r=>r.id===parent);if(!item||item.archived||(item.kind!=='note'&&item.kind!=='drawing'))throw Error('上级知识不存在或已归档');parent=item.knowledgeParentId;
  }
}
export function knowledgeHierarchy(records:RecordItem[],query=''):MindNode[] {
  const entries=knowledgeRecords(records);const root:MindNode={id:knowledgeRoot,parentId:null,title:'个人知识库',body:'',kind:'root',side:1,progress:0,due:''};const nodes=[root];
  const byId=new Map(entries.map(r=>[r.id,r]));
  for(const record of entries){
    const source=record.kind==='note'?record.knowledgeSource:undefined;
    const parent=record.knowledgeParentId===undefined&&source?sourceFolder(source.workspaceId):record.knowledgeParentId;
    if(parent?.startsWith('source:')&&!nodes.some(n=>n.id===parent))nodes.push({...root,id:parent,parentId:knowledgeRoot,title:source?.workspaceName||'工作区资料',kind:'idea'});
    nodes.push({...root,id:record.id,parentId:parent&&(parent.startsWith('source:')||byId.has(parent))?parent:knowledgeRoot,title:record.title,kind:knowledgeFormat(record)==='folder'?'root':knowledgeFormat(record)==='excalidraw'?'artifact':'document'});
  }
  // Old or externally restored invalid parent links remain reachable at the root.
  for(const node of nodes.slice(1)){const seen=new Set([node.id]);let parent=node.parentId;while(parent){if(seen.has(parent)){node.parentId=knowledgeRoot;break;}seen.add(parent);parent=nodes.find(n=>n.id===parent)?.parentId||null;}}
  const search=query.trim().toLowerCase();
  if(!search)return nodes;
  const keep=new Set([knowledgeRoot]);for(const item of entries){let id:string|null=item.id;const ancestors:MindNode[]=[];while(id){const node=nodes.find(n=>n.id===id);if(!node)break;ancestors.push(node);id=node.parentId;}if((recordText(item)+' '+ancestors.map(n=>n.title).join(' ')).toLowerCase().includes(search))for(const node of ancestors)keep.add(node.id);}
  return nodes.filter(n=>keep.has(n.id));
}
export async function importKnowledge(file:File,parentId:string|null):Promise<KnowledgeRecord> {
  if(file.size>MAX_SCENE_BYTES)throw Error('文件超过 20 MB');const text=await file.text();const extension=file.name.split('.').at(-1)?.toLowerCase();
  const format=extension==='excalidraw'?'excalidraw':['html','htm'].includes(extension||'')?'html':['mindmap','northmap'].includes(extension||'')?'mindmap':['md','markdown','txt'].includes(extension||'')?'markdown':extension==='json'?(JSON.parse(text).type==='excalidraw'?'excalidraw':'mindmap'):null;
  if(!format)throw Error('支持 Markdown、HTML、Excalidraw 和 Draftway 思维导图 JSON');
  const record=newKnowledge(format,parentId);record.title=file.name.replace(/\.[^.]+$/,'').slice(0,120)||record.title;
  if(record.kind==='drawing'){parseDrawingScene(text);record.scene=text;}else{record.body=format==='mindmap'?JSON.stringify(parseKnowledgeMap(text)):text;if(new TextEncoder().encode(record.body).length>1_000_000)throw Error('文档超过 1 MB');}
  return record;
}
export const isolatedHtml=(content:string)=>`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">${content}`;
