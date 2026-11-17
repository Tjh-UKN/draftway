import {groups,type DockState,type Edge} from './docking';
export type DockDragItem={kind:'tab'|'group';id:string;label:string};
export interface DockDrop {groupId:string;edge?:Edge;beforeId?:string;marker?:{x:number;y:number;height:number};rect?:{left:number;top:number;width:number;height:number};}
export function dockEdge(rect:{left:number;top:number;width:number;height:number},x:number,y:number):Edge|undefined {
  if(!rect.width||!rect.height)return;
  const across=(x-rect.left)/rect.width,down=(y-rect.top)/rect.height;
  if(across<.2)return 'left';if(across>.8)return 'right';if(down<.2)return 'top';if(down>.8)return 'bottom';
}
export function canDockDrop(dock:DockState,item:DockDragItem,drop:DockDrop):boolean {
  const all=groups(dock.root),target=all.find(g=>g.id===drop.groupId);
  if(!target)return false;
  if(item.kind==='group')return item.id!==drop.groupId&&!!all.find(g=>g.id===item.id)?.tabs.length;
  const source=all.find(g=>g.tabs.includes(item.id));
  if(!source||drop.beforeId===item.id)return false;
  return !drop.edge||((all.length<8||source.tabs.length===1)&&!(source.id===target.id&&source.tabs.length===1));
}
