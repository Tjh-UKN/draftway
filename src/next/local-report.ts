import {localPath} from '../local-paths';
import {updateWorkspace,type WorkbenchState} from './core';
import {groups,openDockTab} from './docking';
export function isHtmlReport(path:string){return /\.html?$/i.test(path);}
export function openLocalReport(state:WorkbenchState,workspaceId:string,value:string,id:string=crypto.randomUUID()):WorkbenchState{
  const path=localPath(value);const space=state.spaces.find(w=>w.id===workspaceId);
  if(!space||!path||!isHtmlReport(path))return state;
  const existing=space.dock.tabs.find(tab=>tab.kind==='browser'&&tab.localFile?.path.toLowerCase()===path.toLowerCase());
  const owner=groups(space.dock.root).find(group=>group.tabs.includes(existing?.id||''));
  const tab={id:existing?.id||id,kind:'browser' as const,title:existing?.title||path.split(/[\\/]/).at(-1)||'HTML 报告',url:'',localFile:{workspaceId,path}};
  return {...updateWorkspace(state,workspaceId,w=>{
    const dock=existing?{...w.dock,tabs:w.dock.tabs.map(item=>item.id===existing.id?tab:item)}:w.dock;
    return {...w,dock:openDockTab(dock,tab,owner?.id||dock.activeGroupId)};
  }),activeId:workspaceId};
}
