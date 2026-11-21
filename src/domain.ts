export type Kind = 'goal' | 'project' | 'task' | 'milestone' | 'note' | 'issue' | 'habit' | 'drawing';
export const isRetiredKind = (kind: unknown): kind is 'journal' | 'sleep' | 'weight' =>
  kind === 'journal' || kind === 'sleep' || kind === 'weight';
export type Status = 'todo' | 'doing' | 'done';
export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';
export interface Base { id: string; kind: Kind; title: string; createdAt: string; updatedAt: string; archived: boolean; version: number; knowledgeParentId?:string|null; }
export interface Goal extends Base { kind: 'goal'; description: string; horizon: 'year' | 'quarter' | 'life'; targetDate: string | null; }
export interface Project extends Base { kind: 'project'; description: string; goalId: string | null; targetDate: string | null; status: 'active' | 'completed'; }
export interface Task extends Base { kind: 'task'; description: string; projectId: string | null; status: Status; priority: 'low' | 'normal' | 'high'; dueAt: string | null; remindAt: string | null; repeat: Repeat; repeatAnchorDay?:number; completedAt: string | null; tags: string[]; }
export interface Milestone extends Base { kind: 'milestone'; projectId: string | null; date: string; remindAt: string | null; category: 'personal' | 'work' | 'finance'; }
export type NoteType = 'note' | 'progress' | 'review';
export type IssueStatus = 'triage' | 'investigating' | 'verifying' | 'resolved';
export interface KnowledgeSource {kind:'node'|'note'; workspaceId:string; workspaceName:string; id:string; category:'artifact'|'document'|'note'; autoUpdate?:boolean;}
export type KnowledgeFormat='markdown'|'html'|'mindmap'|'folder';
export interface Note extends Base { kind: 'note'; projectId: string | null; taskId: string | null; noteType: NoteType; occurredOn: string; body: string; tags: string[]; format?:KnowledgeFormat; knowledgeSource?:KnowledgeSource; }
export interface Issue extends Base { kind:'issue'; projectId:string|null; taskId:string|null; status:IssueStatus; severity:'low'|'normal'|'high'; phenomenon:string; expected:string; reproduction:string; attempts:string; cause:string; solution:string; resolvedAt:string|null; }
export interface Habit extends Base {kind:'habit';description:string;startDate:string;status:'active'|'paused';checkIns:Record<string,string>;}
export interface Drawing extends Base {kind:'drawing';projectId:string|null;scene:string;}
export type RecordItem = Goal | Project | Task | Milestone | Note | Issue | Habit | Drawing;
export interface Attachment { id: string; name: string; size: number; storedName: string; entityId: string | null; createdAt: string; }
export interface Settings { userName: string; theme: 'dark' | 'light'; layout: 'overview' | 'focus'; closeToTray: boolean; autoStart: boolean; notifications: boolean; dailyBackup: boolean; }
export interface WorkbenchData { records: RecordItem[]; attachments: Attachment[]; settings: Settings; dataPath: string; workspaceLayout?: unknown; }
export interface BackupInfo { name: string; createdAt: string; size: number; }
export const defaults: Settings = { userName: '同学', theme: 'dark', layout: 'overview', closeToTray: true, autoStart: false, notifications: true, dailyBackup: true };
export const labels: Record<Kind, string> = { goal: '目标', project: '项目', task: '任务', milestone: '节点', note: '笔记', issue:'问题',habit:'习惯',drawing:'画板' };
export const issueStatuses:Record<IssueStatus,string>={triage:'待排查',investigating:'处理中',verifying:'待验证',resolved:'已解决'};
export const noteTypes:Record<NoteType,string>={note:'笔记',progress:'进展',review:'复盘'};
export const uid = () => crypto.randomUUID();
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export const dateLabel = (value: string | null, withTime = false) => value ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleString('zh-CN', withTime ? {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'} : {month:'numeric',day:'numeric'}) : '未设置时间';
export function makeRecord(kind: Kind): RecordItem {
  const now = new Date().toISOString();
  const base: Base = { id: uid(), kind, title: '', createdAt: now, updatedAt: now, archived: false, version: 0 };
  switch(kind) {
    case 'drawing': return {...base,kind,title:'未命名画板',projectId:null,scene:'{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}'};
    case 'goal': return {...base,kind,description:'',horizon:'year',targetDate:null};
    case 'project': return {...base,kind,description:'',goalId:null,targetDate:null,status:'active'};
    case 'task': return {...base,kind,description:'',projectId:null,status:'todo',priority:'normal',dueAt:null,remindAt:null,repeat:'none',completedAt:null,tags:[]};
    case 'milestone': return {...base,kind,projectId:null,date:dateKey(),remindAt:null,category:'personal'};
    case 'note': return {...base,kind,projectId:null,taskId:null,noteType:'note',occurredOn:dateKey(),body:'',tags:[]};
    case 'issue': return {...base,kind,projectId:null,taskId:null,status:'triage',severity:'normal',phenomenon:'',expected:'',reproduction:'',attempts:'',cause:'',solution:'',resolvedAt:null};
    case 'habit': return {...base,kind,description:'',startDate:dateKey(),status:'active',checkIns:{}};
  }
}
export function isToday(value: string | null, now = new Date()) { return !!value && dateKey(new Date(value)) === dateKey(now); }
export function overdue(t: Task, now = new Date()) { return t.status !== 'done' && !!t.dueAt && new Date(t.dueAt).getTime() < now.getTime(); }
export function sortTasks(tasks: Task[]) { return [...tasks].sort((a,b)=> Number(a.status==='done')-Number(b.status==='done') || Number(b.priority==='high')-Number(a.priority==='high') || (a.dueAt || '9999').localeCompare(b.dueAt || '9999') || a.createdAt.localeCompare(b.createdAt)); }
export function countdown(date: string, now = new Date()) {
  const target = new Date(date.length === 10 ? `${date}T00:00:00` : date);
  const day = new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const days = Math.round((new Date(target.getFullYear(),target.getMonth(),target.getDate()).getTime()-day.getTime())/86400000);
  return days===0 ? '就是今天' : days>0 ? `还有 ${days} 天` : `已过 ${Math.abs(days)} 天`;
}
export function advanceRepeat(value: string, repeat: Repeat, anchorDay?:number): string {
  const date = new Date(value);
  if(repeat==='daily') date.setDate(date.getDate()+1);
  if(repeat==='weekly') date.setDate(date.getDate()+7);
  if(repeat==='monthly') { const originalDay=anchorDay||date.getDate(); date.setDate(1); date.setMonth(date.getMonth()+1); const last=new Date(date.getFullYear(),date.getMonth()+1,0).getDate();date.setDate(Math.min(originalDay,last)); }
  return date.toISOString();
}
export function toggleTask(task: Task): Task { return {...task,status:task.status==='done'?'todo':'done',completedAt:task.status==='done'?null:new Date().toISOString()}; }
export function progress(tasks: Task[]) { const done = tasks.filter(t=>t.status==='done').length; return {done,total:tasks.length,percent:tasks.length?Math.round(done/tasks.length*100):0}; }
export function shiftDay(day:string,amount:number){const date=new Date(`${day}T12:00:00`);date.setDate(date.getDate()+amount);return dateKey(date);}
export function habitStats(habit:Habit,today=dateKey()){
  const dates=Object.keys(habit.checkIns).filter(day=>day>=habit.startDate&&day<=today).sort();const set=new Set(dates);
  let cursor=set.has(today)?today:shiftDay(today,-1);let streak=0;
  while(set.has(cursor)){streak++;cursor=shiftDay(cursor,-1);}
  let longest=0,run=0,previous='';for(const day of dates){run=previous&&shiftDay(previous,1)===day?run+1:1;longest=Math.max(longest,run);previous=day;}
  const week=Array.from({length:7},(_,i)=>shiftDay(today,i-6)).filter(day=>day>=habit.startDate);const weekDone=week.filter(day=>set.has(day)).length;
  return {streak,longest,total:dates.length,todayDone:set.has(today),weekDone,weekTotal:week.length,weekRate:week.length?Math.round(weekDone/week.length*100):0};
}
export function normalizeRecord(record:RecordItem):RecordItem {
  if(record.kind==='note')return {...record,taskId:record.taskId??null,noteType:record.noteType??'note',occurredOn:record.occurredOn??dateKey(new Date(record.createdAt))};
  return record;
}
export function recordText(record:RecordItem):string {if(record.kind==='drawing'){try{const scene=JSON.parse(record.scene);return `${record.title} ${scene.elements.filter((e:{isDeleted?:boolean})=>!e.isDeleted).map((e:{text?:string})=>e.text||'').join(' ')}`;}catch{return record.title;}}return Object.values(record).flatMap(v=>typeof v==='string'?v:Array.isArray(v)?v:[]).join(' ');}
export function archiveClosure(records:RecordItem[],rootId:string):string[]{
  const ids=new Set([rootId]);let changed=true;
  while(changed){changed=false;for(const r of records){if(!ids.has(r.id)&&(('goalId'in r&&r.goalId&&ids.has(r.goalId))||('projectId'in r&&r.projectId&&ids.has(r.projectId))||('taskId'in r&&r.taskId&&ids.has(r.taskId)))){ids.add(r.id);changed=true;}}}
  return Array.from(ids);
}
export type CaptureMode='progress'|'issue'|'note';
export function captureDraft(mode:CaptureMode,source?:Task|Project):RecordItem {
  const day=dateKey();
  const projectId=source?.kind==='project'?source.id:source?.projectId??null;
  const taskId=source?.kind==='task'?source.id:null;
  if(mode==='issue')return {...makeRecord('issue'),kind:'issue',projectId,taskId,title:source?`问题｜${source.title}`.slice(0,120):''} as Issue;
  const note=makeRecord('note') as Note;
  return {...note,projectId,taskId,noteType:mode==='progress'?'progress':'note',occurredOn:day,title:mode==='progress'?`进展｜${source?.title||day}`.slice(0,120):'',body:mode==='progress'?'已完成：\n\n当前进度：\n\n下一步：\n':'',tags:mode==='progress'?['进展']:[]};
}
export function starter(): RecordItem[] {
  const goal = {...makeRecord('goal'),title:'让行动靠近长期方向',description:'从一项你真正关心的目标开始，建立每周复盘的习惯。'} as Goal;
  const project = {...makeRecord('project'),title:'我的第一个项目',description:'你可以编辑这里的内容，或者新建自己的项目。',goalId:goal.id} as Project;
  const t1 = {...makeRecord('task'),title:'写下今天最重要的一件事',projectId:project.id,priority:'high'} as Task;
  const t2 = {...makeRecord('task'),title:'为第一个项目设置一个里程碑',projectId:project.id} as Task;
  const note = {...makeRecord('note'),title:'欢迎来到 Draftway',projectId:project.id,body:'从左侧导航开始，或者按 Ctrl + N 快速新建。\n\n你的目标、项目、任务、节点和笔记可以互相关联。按 Ctrl + K 搜索全部内容。\n\nWindows 版的数据保存在当前用户的 AppData 目录。备份会同时包含数据库与附件。关闭窗口默认进入托盘；需要完全退出时，请使用托盘菜单。\n\n这些入门记录可以编辑或归档。',tags:['入门']} as Note;
  return [goal,project,t1,t2,note];
}
