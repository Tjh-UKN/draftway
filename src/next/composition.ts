import {validateDock,type DockNode,type DockState} from './docking';
import {createWorkspace,type Workspace} from './core';
export interface LayoutTemplate {id:string;name:string;dock:DockState}
export function layoutTemplate(space:Workspace,id:string,name:string):LayoutTemplate {
  const tabs=space.dock.tabs.filter(t=>['map','events','browser','business','review'].includes(t.kind)).map(t=>t.kind==='review'?{...t,title:'文件审查',files:[]}:structuredClone(t));const ids=new Set(tabs.map(t=>t.id));
  const tree=(node:DockNode):DockNode=>node.kind==='group'?{...node,tabs:node.tabs.filter(id=>ids.has(id)),activeId:ids.has(node.activeId)?node.activeId:node.tabs.find(id=>ids.has(id))||''}:{...node,children:node.children.map(tree) as [DockNode,DockNode]};
  return{id,name,dock:{...space.dock,tabs,root:tree(space.dock.root),recent:space.dock.recent.filter(id=>ids.has(id))}};
}
export function fromTemplate(name:string,template:LayoutTemplate,uid:()=>string=()=>crypto.randomUUID()):Workspace {
  const space=createWorkspace(name,'blank');const mapping=new Map(template.dock.tabs.map(t=>[t.id,t.kind==='map'?'workspace':uid()]));
  const tree=(node:DockNode):DockNode=>node.kind==='group'?{...node,tabs:node.tabs.map(id=>mapping.get(id)!),activeId:mapping.get(node.activeId)||''}:{...node,children:node.children.map(tree) as [DockNode,DockNode]};
  const dock={...structuredClone(template.dock),tabs:template.dock.tabs.map(t=>({...structuredClone(t),id:mapping.get(t.id)!})),root:tree(template.dock.root),recent:template.dock.recent.map(id=>mapping.get(id)!)};
  validateDock(dock,[]);return{...space,dock};
}
export {parseIntegration,type ExternalIntegration} from './integration-manifest';
