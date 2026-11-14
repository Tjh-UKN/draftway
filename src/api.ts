import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { advanceRepeat, archiveClosure, dateKey, defaults, healthError, normalizeRecord, starter, uid, type Attachment, type BackupInfo, type Habit, type RecordItem, type Settings, type Task, type WorkbenchData } from './domain';
import {parseDrawingScene} from './drawings';
import {parseWorkspaceLayout, webWorkspaceUrl, type WorkspaceLayout} from './workspace-layout';

export const desktop = isTauri();
const database: Promise<IDBDatabase> = new Promise((resolve,reject)=>{
  if(desktop) return;
  const request=indexedDB.open('northstar-preview-v1',1);
  request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('records',{keyPath:'id'});db.createObjectStore('files',{keyPath:'id'});db.createObjectStore('meta');};
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
});
async function readAll<T>(store:string):Promise<T[]> { const db=await database;return new Promise((resolve,reject)=>{const req=db.transaction(store).objectStore(store).getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);}); }
async function meta<T>(key:string):Promise<T|undefined> {const db=await database;return new Promise((resolve,reject)=>{const req=db.transaction('meta').objectStore('meta').get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function put(store:string,value:unknown,key?:string) {const db=await database;return new Promise<void>((resolve,reject)=>{const tx=db.transaction(store,'readwrite');const target=tx.objectStore(store);if(key)target.put(value,key);else target.put(value);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
async function remove(store:string,id:string) {const db=await database;return new Promise<void>((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
let serial=Promise.resolve();
function queue<T>(fn:()=>Promise<T>):Promise<T>{const result=serial.then(fn);serial=result.then(()=>{},()=>{});return result;}
export async function saveWorkspaceLayout(layout: WorkspaceLayout): Promise<void> {
  parseWorkspaceLayout(layout);
  return queue(async () => {
    if (desktop) await invoke('save_workspace_layout', {layout});
    else await put('meta', layout, 'workspace-layout');
  });
}
export async function loadWorkspace():Promise<WorkbenchData> {
  if(desktop)return invoke('load_workspace');
  return queue(async()=>{
    if(!await meta('initialized')) {for(const item of starter())await put('records',{...item,version:1});await put('meta',true,'initialized');}
    const records=(await readAll<RecordItem>('records')).map(normalizeRecord);const files=await readAll<Attachment & {blob:Blob}>('files');
    return {records,attachments:files.map(({blob:_,...a})=>a),settings:await meta<Settings>('settings')||defaults,dataPath:'此浏览器的 IndexedDB（与 Windows 版数据独立）',workspaceLayout:await meta('workspace-layout')??null};
  });
}
export async function saveRecord(item:RecordItem):Promise<RecordItem> {
  if(desktop)return invoke('save_record',{record:item});
  return queue(async()=>{
    const all=await readAll<RecordItem>('records');const previous=all.find(x=>x.id===item.id);
    if(previous&&previous.version!==item.version)throw new Error('记录已更新，请重新打开后保存');
    const record={...normalizeRecord(item),title:item.title.trim(),version:item.version+1,updatedAt:new Date().toISOString()};
    if(previous?.archived)throw new Error('请先恢复归档记录');
    if(record.kind==='drawing'){if(!record.title||record.title.length>120)throw new Error('画板名称需要 1–120 个字符');parseDrawingScene(record.scene);}
    if(record.kind==='sleep'||record.kind==='weight'){const error=healthError(record);if(error)throw new Error(error);if(all.some(r=>r.kind===record.kind&&!r.archived&&r.date===record.date&&r.id!==record.id))throw new Error('该日期已有同类健康记录，请编辑已有记录');}
    if(record.kind==='habit'){
      if(!record.startDate||record.startDate>dateKey())throw new Error('开始日期不能晚于今天');
      if(Object.keys(record.checkIns).some(day=>day<record.startDate))throw new Error('开始日期不能晚于已有签到');
      if(previous?.kind==='habit'&&JSON.stringify(previous.checkIns)!==JSON.stringify(record.checkIns))throw new Error('请通过签到入口调整记录');
      if(!previous&&Object.keys(record.checkIns).length)throw new Error('新习惯不能直接写入签到记录');
    }
    if('taskId'in record&&record.taskId){const parent=all.find(t=>t.id===record.taskId);if(!parent||parent.kind!=='task'||parent.archived)throw new Error('关联任务不存在或已归档');if(parent.projectId!==record.projectId)throw new Error('记录必须属于关联任务的同一项目');}
    if(record.kind==='journal'&&all.some(r=>r.kind==='journal'&&!r.archived&&r.date===record.date&&r.id!==record.id))throw new Error('这一天已有工作记录，请编辑已有记录');
    if(record.kind==='issue'){if(record.status==='resolved'&&!record.solution.trim())throw new Error('解决问题前请填写解决方法');record.resolvedAt=record.status==='resolved'?(record.resolvedAt||new Date().toISOString()):null;}
    if(record.kind==='task'){
      const t=record as Task;
      t.completedAt=t.status==='done'?(t.completedAt||new Date().toISOString()):null;
      if(t.status==='done'&&t.repeat!=='none'&&t.dueAt&&(!previous||previous.kind!=='task'||previous.status!=='done')){
        const link=`repeat:${t.id}`;
        if(!await meta(link)){
          const anchor=t.repeatAnchorDay||new Date(t.dueAt).getDate();
          const next={...t,id:uid(),version:1,status:'todo' as const,completedAt:null,createdAt:new Date().toISOString(),repeatAnchorDay:anchor,dueAt:advanceRepeat(t.dueAt,t.repeat,anchor)};
          if(t.remindAt)next.remindAt=new Date(new Date(next.dueAt).getTime()-(new Date(t.dueAt).getTime()-new Date(t.remindAt).getTime())).toISOString();
          await put('records',next);await put('meta',next.id,link);
        }
      }
    }
    if(record.kind==='task'&&previous?.kind==='task'&&previous.projectId!==record.projectId){for(const child of all.filter(r=>'taskId'in r&&r.taskId===record.id)){await put('records',{...child,projectId:record.projectId,version:child.version+1,updatedAt:new Date().toISOString()});}}
    await put('records',record);return record;
  });
}
export async function archiveRecord(id:string,restore=false) {
  if(desktop)return invoke<void>('archive_record',{id,restore});
  return queue(async()=>{
    const all=await readAll<RecordItem>('records');const target=all.find(x=>x.id===id);if(!target)throw new Error('记录不存在');
    let ids=[id];
    if(restore){
      const parents=[target.kind==='project'?target.goalId:null,'projectId'in target?target.projectId:null,'taskId'in target?target.taskId:null];
      if(parents.some(parent=>parent&&all.find(x=>x.id===parent)?.archived))throw new Error('请先恢复所属目标、项目或任务');
      ids=[id,...await meta<string[]>(`archive:${id}`)||[]];
      if((target.kind==='sleep'||target.kind==='weight')&&all.some(r=>r.kind===target.kind&&!r.archived&&r.date===target.date&&r.id!==target.id))throw new Error('该日期已有同类健康记录，不能重复恢复');
    }else{
      ids=archiveClosure(all,id);
      ids=ids.filter(x=>!all.find(r=>r.id===x)?.archived);
      await put('meta',ids,`archive:${id}`);
    }
    for(const item of all.filter(x=>ids.includes(x.id)))await put('records',{...item,archived:!restore,version:item.version+1,updatedAt:new Date().toISOString()});
  });
}
export async function checkHabit(id:string,day:string,checked:boolean):Promise<Habit>{
 if(desktop)return invoke('check_habit',{id,day,checked});
 return queue(async()=>{
  const all=await readAll<RecordItem>('records');const current=all.find((r):r is Habit=>r.id===id&&r.kind==='habit');
  if(!current||current.archived)throw new Error('请先恢复或选择有效习惯');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||dateKey(new Date(`${day}T12:00:00`))!==day||day>dateKey()||day<current.startDate)throw new Error('日期必须在开始日期和今天之间');
  if(!!current.checkIns[day]===checked)return current;
  if(checked&&current.status!=='active')throw new Error('请先恢复进行中的习惯');
  const next={...current,checkIns:{...current.checkIns},version:current.version+1,updatedAt:new Date().toISOString()};
  if(checked)next.checkIns[day]=new Date().toISOString();else delete next.checkIns[day];
  await put('records',next);return next;
 });
}
export async function deleteRecord(id:string) {
  if(desktop)return invoke<void>('delete_record',{id});
  return queue(async()=>{const all=await readAll<RecordItem>('records');if(!all.find(x=>x.id===id)?.archived)throw new Error('请先归档');if(all.some(x=>(x.kind==='project'&&x.goalId===id)||('projectId'in x&&x.projectId===id)))throw new Error('请先移除关联的子记录');const files=await readAll<Attachment>('files');if(files.some(x=>x.entityId===id))throw new Error('请先移除关联附件');await remove('records',id);});
}
export async function saveSettings(settings:Settings) {if(desktop)return invoke<void>('save_settings',{settings});await put('meta',settings,'settings');}
export async function selectAttachments(entityId:string|null):Promise<Attachment[]> {
  if(desktop){const paths=await openDialog({multiple:true,directory:false,title:'添加附件'});if(!paths)return [];const selected=Array.isArray(paths)?paths:[paths];const result:Attachment[]=[];for(const path of selected)result.push(await invoke('add_attachment',{path,entityId}));return result;}
  const files=await pickFiles(false);const result:Attachment[]=[];
  for(const file of files){if(file.size>256_000_000)throw new Error('请选择不超过 256 MB 的文件');const item:Attachment={id:uid(),name:file.name,size:file.size,storedName:file.name,entityId,createdAt:new Date().toISOString()};await put('files',{...item,blob:file});result.push(item);}return result;
}
export function pickFiles(single=true,accept=''):Promise<File[]> {return new Promise(resolve=>{const input=document.createElement('input');input.type='file';input.multiple=!single;input.accept=accept;input.addEventListener('change',()=>resolve(Array.from(input.files||[])),{once:true});input.addEventListener('cancel',()=>resolve([]),{once:true});input.click();});}
export async function openAttachment(id:string) {if(desktop)return invoke<void>('open_attachment',{id});const files=await readAll<Attachment & {blob:Blob}>('files');const item=files.find(x=>x.id===id);if(!item)throw new Error('附件不存在');const url=URL.createObjectURL(item.blob);const a=document.createElement('a');a.href=url;a.download=item.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export async function removeAttachment(id:string) {if(desktop)return invoke<void>('remove_attachment',{id});await remove('files',id);}
export const listBackups=()=>desktop?invoke<BackupInfo[]>('list_backups'):Promise.resolve([]);
export const createBackup=()=>desktop?invoke<BackupInfo>('create_backup'):Promise.reject(new Error('完整备份请在 Windows 应用中操作'));
export async function restoreBackup(name?:string) {if(!desktop)throw new Error('请在 Windows 应用中恢复备份');if(name)return invoke<void>('restore_backup',{name,path:null});const path=await openDialog({multiple:false,directory:false,title:'恢复北极星备份',filters:[{name:'北极星备份',extensions:['zip']}]});if(typeof path==='string')return invoke<void>('restore_backup',{name:null,path});return false;}
export async function exportBackup(name:string){if(!desktop)return;const path=await saveDialog({defaultPath:name,filters:[{name:'备份压缩包',extensions:['zip']}]});if(path)await invoke('export_backup',{name,path});}
export const openDataFolder=()=>desktop?invoke<void>('open_data_folder'):Promise.reject(new Error('浏览器预览的数据由浏览器管理'));
export const testNotification=()=>desktop?invoke<void>('test_notification'):Promise.reject(new Error('请在 Windows 应用中测试系统通知'));
export const quitApp=()=>invoke<void>('quit_app');
export async function openExternalUrl(url:string){if(desktop)return invoke<void>('open_external_url',{url});window.open(url,'_blank','noopener,noreferrer');}
export async function openWebWorkspace(url:string) {
  const target = webWorkspaceUrl(url);
  if (desktop) return invoke<void>('open_web_workspace',{url:target});
  window.open(target,'_blank','noopener,noreferrer');
}
export async function exportMarkdown(note:{id:string;title:string;body:string}){
 const name=(note.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().slice(0,80)||'笔记')+'.md';
 if(desktop){const path=await saveDialog({defaultPath:name,filters:[{name:'Markdown 笔记',extensions:['md']}]});if(!path)return false;await invoke('export_markdown',{id:note.id,path});return true;}
 const url=URL.createObjectURL(new Blob([note.body],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);return true;
}
export async function subscribe(onChange:()=>void,onCapture:()=>void,onReminder:(title:string)=>void) {
  if(!desktop)return ()=>{};
  const unlisteners=await Promise.all([listen('workspace-changed',onChange),listen('quick-capture',onCapture),listen<{title:string}>('reminder',e=>onReminder(e.payload.title))]);
  return ()=>unlisteners.forEach(fn=>fn());
}
export async function exportRecords(records:RecordItem[]) {
  if(desktop){const path=await saveDialog({defaultPath:`北极星记录-${new Date().toISOString().slice(0,10)}.json`,filters:[{name:'JSON 记录',extensions:['json']}]});if(path)await invoke('export_records',{path});return;}
  const blob=new Blob([JSON.stringify({format:'northstar-records',version:1,exportedAt:new Date().toISOString(),records},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`北极星记录-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
export async function exportDrawingBlob(blob:Blob,name:string,extension:'excalidraw'|'png'|'svg'){
 if(desktop){const path=await saveDialog({defaultPath:name,filters:[{name:'画板文件',extensions:[extension]}]});if(!path)return false;await invoke('export_drawing_file',{path,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))});return true;}
 const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);return true;
}
