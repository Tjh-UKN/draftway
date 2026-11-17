import {mapGraph,updateMapGraph,updateWorkspace,type WorkbenchState,type Run} from './core';
import type {MindNode} from './model';
import {repairNodeReferences} from './node-operations';

type Update=(state:WorkbenchState)=>WorkbenchState;
type Patch={id:string;before:MindNode|null;after:MindNode|null};
interface Frame {runLinks:{id:string;before:Pick<Run,'targetNodeId'|'mapAction'>;after:Pick<Run,'targetNodeId'|'mapAction'>}[];nodes:Patch[];beforeOrder:string[];afterOrder:string[];links:{id:string;before:{nodeId:string|null;linkedNodeIds?:string[]};after:{nodeId:string|null;linkedNodeIds?:string[]}}[];graphs:{id:string;before:ReturnType<typeof mapGraph>;after:ReturnType<typeof mapGraph>}[];key?:string;at:number;}
export interface MapEditor {state:WorkbenchState;past:Record<string,Frame[]>;future:Record<string,Frame[]>;error:string;}
export const initialMapEditor=(state:WorkbenchState):MapEditor=>({state,past:{},future:{},error:''});
export type MapEditAction={type:'change';update:Update}|{type:'edit';workspaceId:string;update:Update;key?:string;at:number}|{type:'undo'|'redo';workspaceId:string}|{type:'error';message:string};
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function frame(before:WorkbenchState,after:WorkbenchState,id:string,key:string|undefined,at:number):Frame|null {
  const a=before.spaces.find(w=>w.id===id),b=after.spaces.find(w=>w.id===id);if(!a||!b)return null;
  const nodes=[...new Set([...a.nodes,...b.nodes].map(n=>n.id))].map(id=>({id,before:a.nodes.find(n=>n.id===id)||null,after:b.nodes.find(n=>n.id===id)||null})).filter(p=>!equal(p.before,p.after));
  const beforeOrder=a.nodes.map(n=>n.id),afterOrder=b.nodes.map(n=>n.id);
  if(!nodes.length&&equal(beforeOrder,afterOrder))return null;
  const links=before.sessions.filter(s=>s.workspaceId===id).flatMap(s=>{const next=after.sessions.find(n=>n.id===s.id);if(!next)return [];const beforeLink={nodeId:s.nodeId,linkedNodeIds:s.linkedNodeIds},afterLink={nodeId:next.nodeId,linkedNodeIds:next.linkedNodeIds};return equal(beforeLink,afterLink)?[]:[{id:s.id,before:beforeLink,after:afterLink}];});
  const graphs=a.dock.tabs.filter(t=>t.kind==='map').flatMap(t=>{const before=mapGraph(a,t.id),after=mapGraph(b,t.id);return equal(before,after)?[]:[{id:t.id,before,after}];});
  const runLinks=before.runs.flatMap(run=>{const next=after.runs.find(r=>r.id===run.id);if(!next)return [];const a={targetNodeId:run.targetNodeId,mapAction:run.mapAction},b={targetNodeId:next.targetNodeId,mapAction:next.mapAction};return equal(a,b)?[]:[{id:run.id,before:a,after:b}];});
  return {nodes,beforeOrder,afterOrder,links,graphs,key,at,runLinks};
}
function apply(state:WorkbenchState,id:string,entry:Frame,undo:boolean):WorkbenchState {
  const space=state.spaces.find(w=>w.id===id);if(!space)return state;
  const nodes=new Map(space.nodes.map(n=>[n.id,n]));
  for(const patch of entry.nodes) {
    const expected=undo?patch.after:patch.before,desired=undo?patch.before:patch.after,current=nodes.get(patch.id);
    if(!expected){if(current)throw Error('节点已被更新，未覆盖当前内容。');if(desired)nodes.set(patch.id,desired);}
    else if(!desired){if(!equal(current,expected))throw Error('节点已被更新，未删除后续内容。');nodes.delete(patch.id);}
    else {if(!current)throw Error('节点已被移除，未覆盖当前地图。');const next={...current};for(const key of Object.keys({...expected,...desired}) as (keyof MindNode)[])if(!equal(expected[key],desired[key])){if(!equal(current[key],expected[key]))throw Error('节点已被其他操作更新，未覆盖当前内容。');Object.assign(next,{[key]:desired[key]});}nodes.set(patch.id,next);}
  }
  if(nodes.size>250)throw Error('恢复后将超过 250 个节点，本次操作未执行。');
  for(const node of nodes.values()){let parent=node.parentId;const visited=new Set([node.id]);while(parent){if(visited.has(parent)||!nodes.has(parent))throw Error('分支关系已变化，本次操作未执行。');visited.add(parent);parent=nodes.get(parent)!.parentId;}}
  const order=(undo?entry.beforeOrder:entry.afterOrder).filter(id=>nodes.has(id));const known=new Set([...entry.beforeOrder,...entry.afterOrder]);let cursor=0;
  const sorted=space.nodes.filter(n=>nodes.has(n.id)).map(n=>known.has(n.id)?order[cursor++]:n.id).filter(Boolean);sorted.push(...order.slice(cursor));
  let next=updateWorkspace(state,id,w=>({...w,nodes:sorted.map(id=>nodes.get(id)!)}));
  next={...next,sessions:next.sessions.map(session=>{const link=entry.links.find(l=>l.id===session.id);if(!link)return session;const expected=undo?link.after:link.before,desired=undo?link.before:link.after;return equal({nodeId:session.nodeId,linkedNodeIds:session.linkedNodeIds},expected)?{...session,...desired}:session;})};
  next={...next,runs:next.runs.map(run=>{const link=entry.runLinks.find(l=>l.id===run.id);if(!link)return run;const expected=undo?link.after:link.before,desired=undo?link.before:link.after;return equal({targetNodeId:run.targetNodeId,mapAction:run.mapAction},expected)?{...run,...desired}:run;})};
  for(const graph of entry.graphs)next=updateWorkspace(next,id,w=>{if(!w.dock.tabs.some(t=>t.id===graph.id&&t.kind==='map'))return w;const current=mapGraph(w,graph.id),expected=undo?graph.after:graph.before,desired=undo?graph.before:graph.after;return updateMapGraph(w,{...current,selectedId:current.selectedId===expected.selectedId?desired.selectedId:current.selectedId,focusId:current.focusId===expected.focusId?desired.focusId:current.focusId,collapsed:equal(current.collapsed,expected.collapsed)?desired.collapsed:current.collapsed,camera:current.focusId===expected.focusId&&current.focusId!==desired.focusId?null:current.camera},graph.id);});
  return repairNodeReferences(next,id);
}
export function mapEditorReducer(editor:MapEditor,action:MapEditAction):MapEditor {
  if(action.type==='error')return {...editor,error:action.message};
  if(action.type==='change')return {...editor,state:action.update(editor.state)};
  const id=action.workspaceId;
  try {
    if(action.type==='edit'){
      const next=action.update(editor.state);const entry=frame(editor.state,next,id,action.key,action.at);if(!entry)return {...editor,state:next,error:''};
      const past=[...(editor.past[id]||[])];const last=past.at(-1);
      if(entry.key?.startsWith('body:')&&last?.key===entry.key&&entry.at-last.at<1000&&entry.nodes.length===1&&last.nodes.length===1&&entry.nodes[0].id===last.nodes[0].id&&last.nodes[0].after&&entry.nodes[0].after){past[past.length-1]={...last,at:entry.at,nodes:[{...last.nodes[0],after:{...last.nodes[0].after,body:entry.nodes[0].after.body}}]};if(equal(past.at(-1)?.nodes[0].before,past.at(-1)?.nodes[0].after))past.pop();}
      else past.push(entry);
      return {...editor,state:next,past:{...editor.past,[id]:past.slice(-30)},future:{...editor.future,[id]:[]},error:''};
    }
    const undo=action.type==='undo',source=undo?editor.past:editor.future,target=undo?editor.future:editor.past;const stack=source[id]||[];const entry=stack.at(-1);if(!entry)return editor;
    const next=apply(editor.state,id,entry,undo);return {...editor,state:next,[undo?'past':'future']:{...source,[id]:stack.slice(0,-1)},[undo?'future':'past']:{...target,[id]:[...(target[id]||[]),entry]},error:''};
  } catch(error){return {...editor,error:String(error instanceof Error?error.message:error)};}
}
