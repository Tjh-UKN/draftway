import {createMapNode,mapGraph,updateMapGraph,updateWorkspace,type WorkbenchState,type Workspace} from './core';
import {descendants,contentFields,type MindNode} from './model';
import {closeDockTab} from './docking';
import type {GraphState} from './graph-state';

export type NodeSelection=string|string[];
const selectionIds=(value:NodeSelection)=>typeof value==='string'?[value]:value;
function topNodes(nodes:MindNode[],selection:NodeSelection,excludeRoot=false){const selected=new Set(selectionIds(selection).filter(id=>!excludeRoot||nodes.find(n=>n.id===id)?.parentId));return nodes.filter(node=>{if(!selected.has(node.id))return false;let parent=node.parentId;while(parent){if(selected.has(parent))return false;parent=nodes.find(n=>n.id===parent)?.parentId||null;}return true;});}
export const branchIds=(nodes:MindNode[],id:string)=>new Set([id,...descendants(nodes,id).map(node=>node.id)]);
export function repairNodeReferences(state:WorkbenchState,workspaceId:string):WorkbenchState {
  const space=state.spaces.find(w=>w.id===workspaceId);if(!space)return state;
  const ids=new Set(space.nodes.map(n=>n.id));
  const graph=(g:GraphState):GraphState=>({...g,selectedId:g.selectedId&&ids.has(g.selectedId)?g.selectedId:null,focusId:g.focusId&&ids.has(g.focusId)?g.focusId:null,camera:g.focusId&&!ids.has(g.focusId)?null:g.camera,collapsed:g.collapsed.filter(id=>ids.has(id))});
  return {...updateWorkspace(state,workspaceId,w=>{
    let dock=w.dock;for(const tab of dock.tabs)if(tab.kind==='material'&&!ids.has(tab.nodeId))dock=closeDockTab(dock,tab.id);
    return {...w,graph:graph(w.graph),dock:{...dock,tabs:dock.tabs.map(tab=>tab.kind==='map'&&tab.graph?{...tab,graph:graph(tab.graph)}:tab)}};
  }),sessions:state.sessions.map(s=>s.workspaceId!==workspaceId?s:{...s,nodeId:s.nodeId&&ids.has(s.nodeId)?s.nodeId:null,...(s.linkedNodeIds?{linkedNodeIds:s.linkedNodeIds.filter(id=>ids.has(id))}:{})}),runs:state.runs.map(run=>run.targetNodeId&&state.sessions.some(s=>s.id===run.sessionId&&s.workspaceId===workspaceId)&&!ids.has(run.targetNodeId)?{...run,targetNodeId:undefined,mapAction:'reply'}:run)};
}
export function deleteMapBranch(state:WorkbenchState,workspaceId:string,nodeId:NodeSelection):WorkbenchState {
  const space=state.spaces.find(w=>w.id===workspaceId);if(!space)return state;
  const roots=topNodes(space.nodes,nodeId,true);if(!roots.length)return state;
  const removed=new Set(roots.flatMap(n=>[...branchIds(space.nodes,n.id)]));
  return repairNodeReferences(updateWorkspace(state,workspaceId,w=>({...w,nodes:w.nodes.filter(n=>!removed.has(n.id))})),workspaceId);
}
export type NodeDrop='inside'|'before'|'after';
export function moveMapBranch(state:WorkbenchState,workspaceId:string,nodeId:NodeSelection,targetId:string,position:NodeDrop,tabId='workspace'):WorkbenchState {
  const space=state.spaces.find(w=>w.id===workspaceId);const target=space?.nodes.find(n=>n.id===targetId);
  if(!space||!target)return state;const roots=topNodes(space.nodes,nodeId,true);if(!roots.length)return state;
  const rootIds=new Set(roots.map(n=>n.id));const moving=new Set(roots.flatMap(n=>[...branchIds(space.nodes,n.id)]));if(moving.has(targetId)||position!=='inside'&&!target.parentId)return state;
  const parentId=position==='inside'?target.id:target.parentId;
  const remaining=space.nodes.filter(n=>!moving.has(n.id));const targetBranch=branchIds(remaining,targetId);
  const index=position==='before'?remaining.findIndex(n=>n.id===targetId):Math.max(...remaining.map((n,i)=>targetBranch.has(n.id)?i:-1))+1;
  const branch=space.nodes.filter(n=>moving.has(n.id)).map(n=>({...n,side:target.side,parentId:rootIds.has(n.id)?parentId:n.parentId}));
  const nodes=[...remaining.slice(0,index),...branch,...remaining.slice(index)];
  if(nodes.every((n,i)=>n.id===space.nodes[i].id&&n.parentId===space.nodes[i].parentId&&n.side===space.nodes[i].side))return state;
  return updateWorkspace(state,workspaceId,w=>{const graph=mapGraph(w,tabId);const focusId=graph.focusId&&!branchIds(w.nodes,graph.focusId).has(parentId!)?null:graph.focusId;return updateMapGraph({...w,nodes},{...graph,focusId,camera:focusId!==graph.focusId?null:graph.camera,collapsed:graph.collapsed.filter(id=>id!==parentId)},tabId);});
}
export function createMapSibling(state:WorkbenchState,workspaceId:string,nodeId:string,id:string,tabId:string):WorkbenchState {
  const node=state.spaces.find(w=>w.id===workspaceId)?.nodes.find(n=>n.id===nodeId);if(!node)return state;
  if(!node.parentId)return createMapNode(state,workspaceId,node.id,id,tabId);
  const next=createMapNode(state,workspaceId,node.parentId,id,tabId);
  return next===state?state:moveMapBranch(next,workspaceId,id,node.id,'after',tabId);
}
export interface NodeClipboard {nodes:MindNode[];text:string;token:string;}
export function copyMapBranch(space:Workspace,id:NodeSelection):NodeClipboard|null {
  const nodes:MindNode[]=[];const lines:string[]=[];
  const walk=(id:string,depth:number)=>{const node=space.nodes.find(n=>n.id===id);if(!node)return;nodes.push(structuredClone(node));lines.push('\t'.repeat(depth)+node.title);for(const child of space.nodes.filter(n=>n.parentId===id))walk(child.id,depth+1);};for(const root of topNodes(space.nodes,id))walk(root.id,0);
  return nodes.length?{nodes,text:lines.join('\n'),token:crypto.randomUUID()}:null;
}
export function clipboardNodes(text:string,clipboard:NodeClipboard|null):MindNode[] {
  if(clipboard&&text===clipboard.text)return structuredClone(clipboard.nodes);
  const nodes:MindNode[]=[];const stack:{indent:number;id:string}[]=[];
  for(const line of text.replace(/\r\n/g,'\n').split('\n')) {
    if(!line.trim())continue;if(nodes.length>=250)throw Error('一次最多粘贴 250 个节点。');
    const indent=(line.match(/^[\t ]*/)?.[0]||'').replace(/\t/g,'    ').length;while(stack.length&&stack.at(-1)!.indent>=indent)stack.pop();
    const fields=contentFields(line.trim());if(!fields)continue;const id='paste-'+nodes.length;
    nodes.push({id,parentId:stack.at(-1)?.id||null,side:1,kind:'idea',...fields,progress:0,due:''});stack.push({indent,id});
  }
  return nodes;
}
export function pasteMapBranch(state:WorkbenchState,workspaceId:string,parentId:string,nodes:MindNode[],ids:string[],tabId:string):WorkbenchState {
  const space=state.spaces.find(w=>w.id===workspaceId);const parent=space?.nodes.find(n=>n.id===parentId);
  if(!space||!parent||!nodes.length)return state;
  if(space.nodes.length+nodes.length>250)throw Error('工作区最多 250 个节点，本次粘贴未执行。');
  if(ids.length!==nodes.length||new Set(ids).size!==ids.length||ids.some(id=>space.nodes.some(n=>n.id===id)))throw Error('粘贴节点标识无效。');
  const mapping=new Map(nodes.map((n,i)=>[n.id,ids[i]]));
  const copied=nodes.map(n=>{const {sourceArtifactId:_source,updates:_updates,...copy}=n;return {...copy,kind:n.kind==='root'?'idea' as const:n.kind,id:mapping.get(n.id)!,parentId:mapping.get(n.parentId||'')||parentId,side:parent.side};});
  return updateWorkspace(state,workspaceId,w=>updateMapGraph({...w,nodes:[...w.nodes,...copied]},{...mapGraph(w,tabId),collapsed:mapGraph(w,tabId).collapsed.filter(id=>id!==parentId),camera:null},tabId));
}
