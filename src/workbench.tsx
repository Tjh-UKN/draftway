import { createContext, useContext } from 'react';
import type { CaptureMode, Kind, Project, RecordItem, Task, WorkbenchData } from './domain';
export type Page = 'workspaces'|'overview'|'planning'|'tasks'|'issues'|'journal'|'habits'|'health'|'calendar'|'knowledge'|'drawings'|'files'|'archive'|'settings';
export interface Workbench {
  data:WorkbenchData; page:Page; busy:boolean; navigate:(page:Page)=>void;
  capture:(mode:CaptureMode,source?:Task|Project,day?:string)=>void; openProject:(id:string)=>void;
  edit:(record:RecordItem)=>void; create:(kind:Kind,projectId?:string)=>void;
  save:(record:RecordItem)=>Promise<boolean>; archive:(record:RecordItem,restore?:boolean)=>Promise<boolean>;
  refresh:()=>Promise<void>; run:(fn:()=>Promise<unknown>,success?:string)=>Promise<boolean>;
  addFiles:(entityId:string|null)=>Promise<boolean>;
  checkHabit:(id:string,day:string,checked:boolean)=>Promise<boolean>;
  recordHealth:(kind:'sleep'|'weight',day?:string)=>void;
}
export const WorkbenchContext=createContext<Workbench|null>(null);
export const useWorkbench=()=>{const c=useContext(WorkbenchContext);if(!c)throw new Error('Workbench context missing');return c;};
