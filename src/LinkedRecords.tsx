import { ArrowUpRight, CircleAlert, FileText, FolderKanban } from 'lucide-react';
import { Badge } from './components';
import { issueStatuses,labels,noteTypes,type RecordItem } from './domain';
import { useWorkbench } from './workbench';
export default function LinkedRecords({record}:{record:RecordItem}){
 const ctx=useWorkbench();const all=ctx.data.records;const parents:RecordItem[]=[];
 for(const id of ['projectId'in record?record.projectId:null,'taskId'in record?record.taskId:null]){const parent=all.find(r=>r.id===id);if(parent)parents.push(parent);}
 const related=all.filter(r=>r.id!==record.id&&((record.kind==='task'&&'taskId'in r&&r.taskId===record.id)||(record.kind==='issue'&&r.kind==='note'&&r.taskId&&r.taskId===record.taskId)||(record.kind==='journal'&&(record.taskIds.includes(r.id)||record.issueIds.includes(r.id))))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 if(!parents.length&&!related.length)return null;
 return <section className="linked-records"><h3>关联记录</h3>{parents.map(p=><button className="linked-parent" type="button" key={p.id} onClick={()=>ctx.edit(p)}><FolderKanban size={14}/><span>{labels[p.kind]} · {p.title}</span>{p.archived&&<Badge>归档</Badge>}<ArrowUpRight size={13}/></button>)}<div className="linked-record-list">{related.map(r=><button type="button" key={r.id} onClick={()=>ctx.edit(r)}>{r.kind==='issue'?<CircleAlert size={15}/>:<FileText size={15}/>}<div><span>{r.title}</span><small>{r.kind==='issue'?issueStatuses[r.status]:r.kind==='note'?noteTypes[r.noteType]:labels[r.kind]}</small></div>{r.archived&&<Badge>归档</Badge>}<ArrowUpRight size={13}/></button>)}</div></section>;
}
